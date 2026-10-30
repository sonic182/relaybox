import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import type { WAMessage, WASocket } from 'baileys';
import pino, { type Logger } from 'pino';
import QRCode from 'qrcode';
import { MAX_OUTBOUND_MEDIA_BYTES } from './config';
import { clearPostgresAuthState, createPostgresAuthState } from './baileysAuth';
import type { MediaType, SendContextInput, UpdateMessageInput, WAPresence } from './contracts/evolution';
import type { Db } from './db';
import { transcodeToOpus } from './audio';
import { fetchRemoteMedia, InvalidMediaError, type ResolvedMedia } from './mediaFetch';
import { capFileName, fileNameFromUrl, inferMimetype, withExtension } from './mimeTypes';
import { backoffMs } from './queue';
import { isHistorySyncEnabled, readSettings } from './settings';
import { isChatAlias, type ChatAlias } from './chatIdentity';

/** Downloaded media bytes live here; files are keyed by instance and message id. */
export const MEDIA_DIR = process.env.MEDIA_DIR ?? 'media';

// ponytail: no size guard yet; add one (skip downloads over a cap) if huge documents land.

/** Content types whose payload is downloadable media. */
export const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']);

export type InstanceStatus = 'connecting' | 'qr' | 'open' | 'close';

export type Instance = {
  /** Stable identifier that survives restarts and owns the Baileys auth state. */
  id: string;
  name: string;
  status: InstanceStatus;
  /** raw QR payload, rendered to an image in the browser */
  qr?: string;
  /** `qr` encoded as a PNG data URL, for consumers that render it themselves. */
  qrDataUrl?: string;
  user?: string;
  /** True while `close` is a dead pairing (phone-side logout); reconnect must re-scan a QR. */
  loggedOut?: boolean;
};

/** What moved, so a consumer can map the change without diffing snapshots. */
export type InstanceChange = 'qr' | 'connection';

/**
 * A Baileys message flattened to the fields we persist and publish. Raw Baileys objects
 * stop here; `message` keeps the untouched content because replay needs it.
 */
export type InboundMessage = {
  key: {
    /** Always the phone-number JID when WhatsApp gives us one; see `preferPhoneNumber`. */
    remoteJid: string;
    fromMe: boolean;
    id: string;
    participant?: string;
    /** The LID form, when the chat is addressed by LID. */
    remoteJidAlt?: string;
    participantAlt?: string;
    /** Which form `remoteJid` is in: `pn` once we have resolved a phone number. */
    addressingMode?: string;
  };
  pushName?: string;
  message: Record<string, unknown>;
  /** Metadata beside the content: mentions, quotes, and the ad a lead arrived from. */
  contextInfo?: unknown;
  messageType: string;
  /** Unix seconds, as WhatsApp sends it. */
  messageTimestamp: number;
  /** The instance that sent or received it; the reference carries it on every message. */
  instanceId: string;
  source?: string;
  status?: string;
  /** Downloaded bytes, attached when the media fetch succeeded; in-process only. */
  media?: { buffer: Buffer; mimetype: string };
};

/**
 * A group's own name, which no message carries: `pushName` is the sender's. Without this a
 * group chat can only be shown by its JID.
 */
export type GroupSummary = { id: string; subject: string };

/** A contact's own name; unlike `pushName`, it is stable across messages. */
export type ContactSummary = { id: string; name: string };

/** A normalized delivery receipt. Non-receipt Baileys updates stay unsupported. */
export type MessageUpdate = {
  key: InboundMessage['key'];
  status: string;
};

/** A protocol edit, kept in the reference's raw payload shape for webhook compatibility. */
export type EditedMessage = {
  key: InboundMessage['key'];
  data: Record<string, unknown>;
  message: Record<string, unknown>;
  messageType: string;
  messageTimestamp: number;
};

export type InstanceEvent =
    | { type: 'created'; instance: Instance }
    | { type: 'updated'; instance: Instance; change: InstanceChange }
    | { type: 'messages'; instance: Instance; messages: InboundMessage[] }
    | { type: 'message-edited'; instance: Instance; message: EditedMessage }
    | { type: 'message-updated'; instance: Instance; update: MessageUpdate }
    | { type: 'message-deleted'; instance: Instance; key: InboundMessage['key'] }
    | { type: 'sent'; instance: Instance; message: InboundMessage }
    | { type: 'sent-message-update'; instance: Instance; message: EditedMessage }
    | { type: 'groups'; instance: Instance; groups: GroupSummary[] }
    | { type: 'contacts'; instance: Instance; contacts: ContactSummary[] }
    | { type: 'history'; instance: Instance; messages: InboundMessage[]; contacts: ContactSummary[] }
    | { type: 'chat-alias'; instance: Instance; alias: ChatAlias }
    | { type: 'deleted'; name: string };

/**
 * WhatsApp normally supplies `notify` (the profile name), and LID contacts need their
 * phone-number JID to match the normalized chat projection.
 */
export function toContactSummaries(
  contacts: { id?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string; username?: string }[],
): ContactSummary[] {
  return contacts.flatMap(({ id, phoneNumber, name, notify, verifiedName, username }) => {
    const displayName = [name, notify, verifiedName, username].find(
      (value): value is string => typeof value === 'string' && Boolean(value.trim()),
    );
    const jid = phoneNumber ?? id;
    return jid && displayName && !jid.endsWith('@g.us') ? [{ id: jid, name: displayName.trim() }] : [];
  });
}

export type InstanceEventListener = (event: InstanceEvent) => void | Promise<void>;

export type SendTextOptions = SendContextInput & {
  /** Simulate typing for this many ms before delivering (chunked at 20 s, like the reference). */
  delay?: number;
  /** Presence shown during the delay; default `composing`. */
  presence?: WAPresence;
  /** `false` suppresses the link preview; anything else leaves Baileys' default. */
  linkPreview?: boolean;
};

export type SendMediaOptions = SendTextOptions & {
  caption?: string;
  fileName?: string;
};

export type SendAudioOptions = SendTextOptions & {
  /** Set false to send the bytes untouched, for a caller that already encoded ogg/opus. */
  encoding?: boolean;
};

export type CreateInstanceOptions = {
  failIfExists?: boolean;
};

export type InstanceService = {
  listInstances(): Instance[];
  getInstance(name: string): Instance | undefined;
  createInstance(name: string, options?: CreateInstanceOptions): Promise<Instance>;
  renameInstance(name: string, newName: string): Promise<void>;
  sendText(name: string, number: string, text: string, options?: SendTextOptions): Promise<InboundMessage>;
  /** `media` is an `http(s)` URL the server fetches, or a base64-encoded payload. An omitted `mimetype` is inferred from the file name, URL, content-type, or leading bytes. */
  sendMedia(name: string, number: string, mediatype: MediaType, media: string, mimetype: string | undefined, options?: SendMediaOptions): Promise<InboundMessage>;
  /** Sends `audio` as a push-to-talk voice note; same source forms as `sendMedia`'s `media`. */
  sendAudio(name: string, number: string, audio: string, options?: SendAudioOptions): Promise<InboundMessage>;
  /** Downloads a stored WhatsApp payload on demand; undefined when unavailable. */
  downloadMessageMedia(name: string, message: Pick<InboundMessage, 'key' | 'message' | 'messageType'>): Promise<InboundMessage['media']>;
  /** WhatsApp CDN URL for a contact/group avatar; undefined when none is set. */
  getProfilePictureUrl(name: string, jid: string): Promise<string | undefined>;
  /** Public fields WhatsApp exposes for a Business account; it does not include its name. */
  getBusinessProfile(name: string, jid: string): Promise<Record<string, unknown> | undefined>;
  editMessage(name: string, input: UpdateMessageInput): Promise<Record<string, unknown>>;
  disconnectInstance(name: string): Promise<void>;
  /** Unpairs the WhatsApp session, unlike `disconnectInstance`; a later connect needs a fresh QR. */
  logoutInstance(name: string): Promise<void>;
  reconnectInstance(name: string): Promise<void>;
  /** Shows a connected instance as online (`available`) or offline (`unavailable`) to contacts; a no-op otherwise. */
  setOnlinePresence(name: string, online: boolean): Promise<void>;
  deleteInstance(name: string): Promise<void>;
  restoreInstances(): Promise<void>;
  subscribe(listener: InstanceEventListener): () => void;
};

type LiveInstance = Instance & {
  sock?: WASocket;
  /** Set while intentionally closing a socket so its close event cannot reconnect it. */
  stopped?: boolean;
  /** Consecutive close-triggered reconnects; drives backoff and resets on `open`. */
  reconnectAttempts?: number;
  /** Bumped by every live presence push, so an older re-check read cannot override it. */
  presencePushes?: number;
};

/** Caps a flapping connection's reconnect rate; unbounded retries otherwise hammer Postgres and Baileys. */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

type InstanceServiceOptions = {
  db: Db;
  logger: Logger;
};

/** Delivery-receipt levels, indexed by the Baileys numeric status. */
const MESSAGE_STATUS = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];
// Baileys logs Signal session keys at info level; application logs already cover socket state.
const BAILEYS_LOGGER = pino({ level: 'silent' });

/**
 * WhatsApp addresses some chats by LID, an opaque id whose digits are not a phone number.
 * The phone-number JID rides along in the matching `*Alt` field, so prefer it and keep the
 * LID beside it. The reference does the same swap before delivering the webhook
 * (`whatsapp.baileys.service.ts:1668`).
 */
function preferPhoneNumber(jid: string, alt: string | undefined): [string, string | undefined] {
  return jid.endsWith('@lid') && alt ? [alt, jid] : [jid, alt];
}

/**
 * Byte fields — `messageSecret`, `ctwaPayload`, media keys — otherwise serialize as an array
 * of 32 numbers or an object keyed by index, which bloats every stored row and webhook body.
 * Base64 is protobuf's own JSON convention. The reference normalizes these to `Uint8Array`
 * instead, which serializes just as badly, so this deliberately differs from it.
 */
function encodeBytes(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');

  // A Buffer's own toJSON already ran, so the replacer sees its {type, data} form.
  const buffer = value as { type?: string; data?: number[] } | null;
  if (buffer?.type === 'Buffer' && Array.isArray(buffer.data)) {
    return Buffer.from(buffer.data).toString('base64');
  }

  return value;
}

/**
 * Baileys hands back protobuf class instances and raw buffers, not plain objects, and both
 * the database and the webhook body need real JSON.
 */
function toPlainJson<T>(value: T): T {
  return value === undefined || value === null ? value : (JSON.parse(JSON.stringify(value, encodeBytes)) as T);
}

/** Injected from the dynamic Baileys import so this module never loads it eagerly. */
export type MessageHelpers = {
  getContentType(message: WAMessage['message']): string | undefined;
  getDevice(id: string): string;
  /** Drops the `:12` device suffix; one contact is one chat. */
  jidNormalizedUser(jid: string | undefined): string;
};

/** Normalizes the key shape shared by message upserts and receipt/delete updates. */
export function toMessageKey(raw: WAMessage['key'], helpers: MessageHelpers): InboundMessage['key'] | undefined {
  const { id, remoteJid, remoteJidAlt, fromMe, participant, participantAlt, addressingMode } = raw ?? {};
  if (!id || !remoteJid) return undefined;

  // jidNormalizedUser returns '' for anything it cannot decode; keep the raw jid instead.
  const normalize = (jid: string | undefined) => (jid ? helpers.jidNormalizedUser(jid) || jid : undefined);
  const [chatJid, chatAlt] = preferPhoneNumber(remoteJid, remoteJidAlt);
  const [senderJid, senderAlt] = participant
    ? preferPhoneNumber(participant, participantAlt)
    : [undefined, undefined];

  return {
    remoteJid: normalize(chatJid) as string,
    fromMe: Boolean(fromMe),
    id,
    ...(senderJid ? { participant: normalize(senderJid) } : {}),
    ...(chatAlt ? { remoteJidAlt: normalize(chatAlt) } : {}),
    ...(senderAlt ? { participantAlt: normalize(senderAlt) } : {}),
    ...(chatJid !== remoteJid ? { addressingMode: 'pn' } : addressingMode ? { addressingMode } : {}),
  };
}

/**
 * Normalizes one Baileys message. Returns undefined for anything without the fields we
 * key on, which is how stubs, receipts, and malformed updates get dropped.
 */
export function toInboundMessage(raw: WAMessage, helpers: MessageHelpers, instanceId: string): InboundMessage | undefined {
  const key = toMessageKey(raw.key, helpers);
  if (!key || !raw.message) return undefined;
  // A revoke, an edit, or a change to the chat's disappearing timer is a protocol event,
  // not something anyone sent. Delivering it puts an empty message in a consumer's inbox,
  // so the reference drops it too (whatsapp.baileys.service.ts:1354).
  if (raw.message.protocolMessage || raw.message.editedMessage?.message?.protocolMessage) return undefined;

  const message = { ...raw.message } as Record<string, unknown>;
  let messageType = helpers.getContentType(raw.message) ?? 'unknown';

  // A click-to-WhatsApp ad referral (externalAdReply, ctwaPayload) rides in the content
  // node's own contextInfo, whichever node that is: extended text for a text ad, the
  // media node for one with a creative. Read it before the collapse below deletes the
  // text node, and surface it beside `message` so a consumer looks in one place. The
  // reference reads only messageContextInfo, which no content node populates.
  const content = message[messageType];
  const nested =
    content && typeof content === 'object' ? (content as { contextInfo?: unknown }).contextInfo : undefined;
  const contextInfo = nested ?? (raw.message.messageContextInfo as unknown);

  // The reference collapses extended text into a plain conversation before storing it.
  const extended = message.extendedTextMessage as { text?: string } | undefined;
  if (extended) {
    messageType = 'conversation';
    message.conversation = extended.text;
    delete message.extendedTextMessage;
  }

  const timestamp = raw.messageTimestamp;
  return {
    key,
    ...(raw.pushName ? { pushName: raw.pushName } : {}),
    message: toPlainJson(message),
    ...(contextInfo ? { contextInfo: toPlainJson(contextInfo) } : {}),
    messageType,
    messageTimestamp:
            typeof timestamp === 'object' && timestamp ? timestamp.toNumber() : Number(timestamp ?? 0),
    instanceId,
    source: helpers.getDevice(key.id),
    // An inbound message with no receipt yet has still reached us.
    status: MESSAGE_STATUS[raw.status ?? -1] ?? (key.fromMe ? undefined : 'DELIVERY_ACK'),
  };
}

/**
 * Accepts a bare number or an already-qualified JID, so a caller need not know WhatsApp's
 * addressing. ponytail: no country-specific fixups; the reference rewrites Brazilian numbers
 * to add or drop the ninth digit. Add that when a Brazilian number actually fails.
 */
export function toRecipientJid(number: string): string {
  const trimmed = number.trim();
  if (trimmed.includes('@')) {
    // A JID needs a local part; '@' or '@s.whatsapp.net' is junk, not a recipient.
    const [local] = trimmed.split('@');
    return local?.trim() ? trimmed : '';
  }

  const digits = trimmed.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

async function readMediaStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > MAX_OUTBOUND_MEDIA_BYTES) {
      stream.destroy();
      throw new Error(`media exceeds the ${MAX_OUTBOUND_MEDIA_BYTES}-byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shows `presence` (default `composing`) to the recipient for `delay` ms, then `paused`,
 * chunked at 20 s in case WhatsApp drops the presence. Matches the reference loop in
 * `whatsapp.baileys.service.ts`. The message is sent by the caller after this returns.
 */
async function typeFor(sock: WASocket, jid: string, delay: number, presence?: WAPresence): Promise<void> {
  const show = presence ?? 'composing';
  let remaining = delay;
  while (remaining > 20000) {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate(show, jid);
    await sleep(20000);
    await sock.sendPresenceUpdate('paused', jid);
    remaining -= 20000;
  }
  if (remaining > 0) {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate(show, jid);
    await sleep(remaining);
    await sock.sendPresenceUpdate('paused', jid);
  }
}

/**
 * `media` is an `http(s)` URL (fetched here, guarded against SSRF by `fetchRemoteMedia`) or
 * a base64 payload. A fetched payload also carries its response `content-type`.
 */
async function resolveMedia(media: string, field = 'media'): Promise<ResolvedMedia> {
  let url: URL | undefined;
  try {
    url = new URL(media);
  } catch {
    url = undefined;
  }

  if (url && url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidMediaError(`"${field}" URL must use http or https`);
  }

  const resolved: ResolvedMedia = url
    ? { ...(await fetchRemoteMedia(media, { maxBytes: MAX_OUTBOUND_MEDIA_BYTES })), url: url.href }
    : { buffer: decodeBase64Media(media, field) };

  if (resolved.buffer.byteLength > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new InvalidMediaError(`"${field}" exceeds the ${MAX_OUTBOUND_MEDIA_BYTES}-byte limit`);
  }
  return resolved;
}

function decodeBase64Media(media: string, field: string): Buffer {
  const value = media.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new InvalidMediaError(`"${field}" must be an http(s) URL or valid base64`);
  }

  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const buffer = Buffer.from(padded, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new InvalidMediaError(`"${field}" must be an http(s) URL or valid base64`);
  }
  return buffer;
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/**
 * Resolves the reference's `Metadata` context fields into what Baileys wants: a `quoted`
 * message to reply to, and the JIDs to mention. Shared by every send so text, media, and
 * audio behave identically rather than each growing its own copy.
 *
 * Mentions apply to groups only, as they do in the reference: a one-to-one chat has nobody
 * to mention, and it builds an empty contextInfo there.
 */
async function buildSendContext(
  sock: WASocket,
  db: Db,
  instanceId: string,
  jid: string,
  options: SendContextInput | undefined,
): Promise<{ mentions?: string[]; quoted?: WAMessage }> {
  const context: { mentions?: string[]; quoted?: WAMessage } = {};

  if (options?.quoted) {
    const { key, message } = options.quoted;
    if (message) {
      context.quoted = { key, message } as WAMessage;
    } else {
      // Only the key came in, so recover the body we stored when the message arrived.
      const stored = await db.message.findFirst({
        where: {
          instanceId,
          keyId: key.id,
          ...(key.remoteJid ? { remoteJid: key.remoteJid } : {}),
          ...(key.fromMe !== undefined ? { fromMe: key.fromMe } : {}),
        },
      });
      // The reference sends unquoted when it cannot find the message, rather than failing.
      if (stored) {
        context.quoted = {
          key: {
            id: stored.keyId,
            remoteJid: stored.remoteJid,
            fromMe: stored.fromMe,
            ...(stored.participant ? { participant: stored.participant } : {}),
          },
          message: stored.content,
        } as WAMessage;
      }
    }
  }

  if (!isGroupJid(jid)) return context;

  if (options?.mentionsEveryOne) {
    const metadata = await sock.groupMetadata(jid);
    context.mentions = metadata.participants.map((participant) => participant.id);
  } else if (options?.mentioned?.length) {
    context.mentions = options.mentioned
      .map((mention) => toRecipientJid(mention))
      // A group cannot mention another group, and an unparseable entry is not a person.
      .filter((mention): mention is string => Boolean(mention) && !isGroupJid(mention as string));
  }

  return context;
}

/** What WhatsApp labels a voice note as, and what `transcodeToOpus` produces. */
const OPUS_MIMETYPE = 'audio/ogg; codecs=opus';

/** Headerless PCM carries no format to detect, so the reference keys off the URL suffix too. */
function isLpcmSource(audio: string): boolean {
  try {
    return /\.lpcm$/i.test(new URL(audio).pathname);
  } catch {
    return false;
  }
}

/** Baileys' media content shapes differ per type; `document` alone requires `fileName`-capable framing. */
function buildMediaContent(
  mediatype: MediaType,
  media: Buffer,
  mimetype: string,
  caption?: string,
  fileName?: string,
): Parameters<WASocket['sendMessage']>[1] {
  switch (mediatype) {
    case 'image':
      return { image: media, mimetype, ...(caption ? { caption } : {}) };
    case 'video':
      return { video: media, mimetype, ...(caption ? { caption } : {}) };
    case 'document':
      return { document: media, mimetype, ...(fileName ? { fileName } : {}), ...(caption ? { caption } : {}) };
    // A file-style bubble, not a voice note; `sendWhatsAppAudio` is the push-to-talk path.
    case 'audio':
      return { audio: media, mimetype };
  }
}

/** Extracts the reference payload from a protocol edit without exposing its protobuf wrapper. */
export function toEditedMessage(raw: WAMessage, helpers: MessageHelpers): EditedMessage | undefined {
  const protocol = raw.message?.protocolMessage ?? raw.message?.editedMessage?.message?.protocolMessage;
  if (!protocol?.key || !protocol.editedMessage) return undefined;

  const key = toMessageKey(protocol.key, helpers);
  const message = toPlainJson(protocol.editedMessage) as Record<string, unknown>;
  if (!key || !message || typeof message !== 'object') return undefined;

  return {
    key,
    data: toPlainJson(protocol) as Record<string, unknown>,
    message,
    messageType: helpers.getContentType(protocol.editedMessage) ?? 'unknown',
    messageTimestamp:
            typeof raw.messageTimestamp === 'object' && raw.messageTimestamp
              ? raw.messageTimestamp.toNumber()
              : Number(raw.messageTimestamp ?? 0),
  };
}

/** Raised when an instance exists but has no live socket to send through. */
export class InstanceNotConnectedError extends Error {
  constructor(name: string) {
    super(`The "${name}" instance is not connected`);
    this.name = 'InstanceNotConnectedError';
  }
}

export class InstanceAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`The "${name}" instance already exists`);
    this.name = 'InstanceAlreadyExistsError';
  }
}

export class InstanceNameTakenError extends Error {
  constructor(name: string) {
    super(`The "${name}" instance name is already in use`);
    this.name = 'InstanceNameTakenError';
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const value = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (value.code === 'P2002' || value.code === '23505') return true;
  if (typeof value.message === 'string' && /duplicate key value violates unique constraint|unique constraint/i.test(value.message)) {
    return true;
  }
  return value.cause !== undefined && isUniqueConstraintError(value.cause);
}

/** Instance names become directory names, so keep them boring. */
export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

/**
 * Owns WhatsApp socket state and database-backed session state. It has no HTTP or rendering
 * dependencies; consumers use snapshots and subscribe to lifecycle events.
 */
export function createInstanceService(options: InstanceServiceOptions): InstanceService {
  const { db, logger } = options;
  const instances = new Map<string, LiveInstance>();
  const listeners = new Set<InstanceEventListener>();
  const reconnects = new Map<string, Promise<void>>();
  const creations = new Map<string, Promise<Instance>>();

  function snapshot({ id, name, status, qr, qrDataUrl, user, loggedOut }: LiveInstance): Instance {
    return { id, name, status, qr, qrDataUrl, user, loggedOut };
  }

  function emit(event: InstanceEvent): void {
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => {
          // A consumer hook must not interrupt the socket lifecycle.
        });
      } catch {
        // A synchronously thrown hook must not interrupt the socket lifecycle.
      }
    }
  }

  /** Lifecycle metadata is persisted so it survives a restart; the write is never awaited. */
  function persistStatus(instance: LiveInstance): void {
    void db.instanceRecord
      .update({
        where: { id: instance.id },
        data: {
          connectionStatus: instance.status,
          ...(instance.user ? { ownerJid: instance.user } : {}),
          ...(instance.status === 'open' ? { connectedAt: new Date() } : {}),
        },
      })
      .catch(() => {
        // A metadata write must not interrupt the socket lifecycle.
      });
  }

  function notifyUpdated(instance: LiveInstance, change: InstanceChange): void {
    if (instances.has(instance.name)) {
      persistStatus(instance);
      emit({ type: 'updated', instance: snapshot(instance), change });
    }
  }

  function clearQr(instance: LiveInstance): void {
    instance.qr = undefined;
    instance.qrDataUrl = undefined;
  }

  function requireValidName(name: string): void {
    if (!isValidName(name)) {
      throw new Error('Invalid instance name');
    }
  }

  async function connect(instance: LiveInstance): Promise<void> {
    const {
      default: makeWASocket,
      DisconnectReason,
      getContentType,
      getDevice,
      jidNormalizedUser,
      downloadMediaMessage,
      BufferJSON,
      initAuthCreds,
      proto,
    } = await import('baileys');

    const { state, saveCreds } = await createPostgresAuthState(db, instance.id, { BufferJSON, initAuthCreds, proto });
    // Off sends `unavailable` on connect, so contacts do not see the number online and the
    // phone keeps receiving notifications. A cosmetic setting must not block connecting.
    const alwaysOnline = await readSettings(db, instance.id).then(
      (settings) => settings.alwaysOnline,
      (err: unknown) => {
        logger.warn({ err, instance: instance.name }, 'presence setting read failed; connecting offline');
        return false;
      },
    );
    const sock = makeWASocket({ auth: state, logger: BAILEYS_LOGGER, markOnlineOnConnect: alwaysOnline });
    instance.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (!instances.has(instance.name) || instance.sock !== sock) return;
      logger.debug({ instance: instance.name, type, count: messages.length }, 'baileys messages.upsert');
      // 'notify' is live traffic and 'append' is backfill; the rest are not messages.
      if (type !== 'notify' && type !== 'append') return;

      const helpers = { getContentType, getDevice, jidNormalizedUser };
      const edits = messages.flatMap((raw) => {
        try {
          const message = toEditedMessage(raw, helpers);
          return message ? [message] : [];
        } catch {
          return [];
        }
      });
      for (const message of edits) emit({ type: 'message-edited', instance: snapshot(instance), message });

      const pairs = messages.flatMap((raw) => {
        try {
          const message = toInboundMessage(raw, helpers, instance.id);
          return message ? [{ raw, message }] : [];
        } catch {
          // One unreadable message must not discard the rest of the batch.
          return [];
        }
      });
      // Media arrives on the same upsert; fetch it here while the socket still lives.
      // A failed download keeps the message, which then renders as its type label.
      for (const { raw, message } of pairs) {
        if (!MEDIA_TYPES.has(message.messageType)) continue;
        try {
          const stream = await downloadMediaMessage(raw, 'stream', {}, {
            logger: BAILEYS_LOGGER,
            reuploadRequest: sock.updateMediaMessage,
          });
          const buffer = await readMediaStream(stream);
          const node = (raw.message as Record<string, { mimetype?: string } | undefined> | null)?.[
            message.messageType
          ];
          message.media = { buffer, mimetype: node?.mimetype ?? 'application/octet-stream' };
        } catch (err) {
          logger.debug({ err, instance: instance.name, keyId: message.key.id }, 'media download failed');
        }
        if (instance.sock !== sock) break;
      }
      const inbound = pairs.map((pair) => pair.message);
      if (inbound.length) emit({ type: 'messages', instance: snapshot(instance), messages: inbound });
    });
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (!instances.has(instance.name) || instance.sock !== sock) return;
      const alias = { lid: jidNormalizedUser(lid), pn: jidNormalizedUser(pn) };
      if (isChatAlias(alias)) emit({ type: 'chat-alias', instance: snapshot(instance), alias });
    });
    sock.ev.on('messaging-history.set', async ({ messages, contacts, syncType, progress, isLatest }) => {
      if (!instances.has(instance.name) || instance.sock !== sock) return;
      logger.debug(
        { instance: instance.name, syncType, progress, isLatest, messages: messages.length, contacts: contacts.length },
        'baileys messaging-history.set',
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        if (!instances.has(instance.name) || instance.sock !== sock) return;
        try {
          if (!(await isHistorySyncEnabled(db, instance.id))) return;
          break;
        } catch (err) {
          if (attempt === 2) {
            logger.error({ err, instance: instance.name }, 'failed to read history sync setting; skipping history');
            return;
          }
          logger.debug({ err, instance: instance.name, attempt: attempt + 1 }, 'retrying history sync setting read');
          await delay(100 * 2 ** attempt);
        }
      }
      if (!instances.has(instance.name) || instance.sock !== sock) return;

      const helpers = { getContentType, getDevice, jidNormalizedUser };
      let skipped = 0;
      const inbound = messages.flatMap((raw) => {
        try {
          const message = toInboundMessage(raw, helpers, instance.id);
          if (message) return [message];
        } catch {
          // Malformed messages must not prevent the rest of the batch from importing.
        }
        skipped++;
        return [];
      });
      if (skipped) logger.debug({ instance: instance.name, skipped }, 'skipped history message conversions');
      const named = toContactSummaries(contacts);
      if (inbound.length || named.length) {
        emit({ type: 'history', instance: snapshot(instance), messages: inbound, contacts: named });
      }
    });
    sock.ev.on('messages.update', (updates) => {
      if (!instances.has(instance.name) || instance.sock !== sock) return;

      for (const { key: rawKey, update } of updates) {
        try {
          const key = toMessageKey(rawKey, { getContentType, getDevice, jidNormalizedUser });
          if (!key || key.remoteJid === 'status@broadcast') continue;

          // Edits arrive as the protocol wrapper on `messages.upsert`, matching the
          // reference; `messages.update` carries only receipts and revokes. Detecting
          // an edit here too would double-emit when the upsert wrapper also arrives.
          // Baileys signals a revoke on messages.update, not messages.delete.
          if (update.message === null && update.status === undefined) {
            emit({ type: 'message-deleted', instance: snapshot(instance), key });
            continue;
          }

          const status = typeof update.status === 'number' ? MESSAGE_STATUS[update.status] : undefined;
          // Edits, stars, polls, and other non-receipt updates have dedicated
          // Evolution events we do not support yet.
          if (!status) {
            logger.debug(
              { instance: instance.name, keyId: key.id, rawStatus: update.status, updateKeys: Object.keys(update) },
              'baileys messages.update ignored',
            );
            continue;
          }

          logger.debug(
            { instance: instance.name, keyId: key.id, remoteJid: key.remoteJid, fromMe: key.fromMe, status },
            'baileys messages.update',
          );

          emit({ type: 'message-updated', instance: snapshot(instance), update: { key, status } });
        } catch {
          // One malformed update must not discard the rest of the batch.
        }
      }
    });
    sock.ev.on('messages.delete', (deleted) => {
      if (!instances.has(instance.name) || instance.sock !== sock || !('keys' in deleted)) return;

      for (const rawKey of deleted.keys) {
        const key = toMessageKey(rawKey, { getContentType, getDevice, jidNormalizedUser });
        if (key && key.remoteJid !== 'status@broadcast') {
          emit({ type: 'message-deleted', instance: snapshot(instance), key });
        }
      }
    });
    for (const event of ['contacts.upsert', 'contacts.update'] as const) {
      sock.ev.on(event, (contacts) => {
        if (!instances.has(instance.name) || instance.sock !== sock) return;

        const named = toContactSummaries(contacts);
        logger.debug(
          { instance: instance.name, received: contacts.length, named },
          `baileys ${event}`,
        );
        if (named.length) emit({ type: 'contacts', instance: snapshot(instance), contacts: named });
      });
    }
    // Both carry the subject; an update carries only what changed, so most fields are absent.
    for (const event of ['groups.upsert', 'groups.update'] as const) {
      sock.ev.on(event, (groups: Partial<GroupSummary>[]) => {
        if (!instances.has(instance.name) || instance.sock !== sock) return;

        const named = groups.flatMap(({ id, subject }) =>
          id && subject?.trim() ? [{ id, subject: subject.trim() }] : [],
        );
        logger.debug(
          { instance: instance.name, received: groups.length, named },
          `baileys ${event}`,
        );
        if (named.length) emit({ type: 'groups', instance: snapshot(instance), groups: named });
      });
    }
    sock.ev.on('connection.update', (update) => {
      // Ignore events from removed instances or a socket superseded by a reconnect.
      if (!instances.has(instance.name) || instance.sock !== sock) return;
      logger.debug(
        { instance: instance.name, connection: update.connection, hasQr: Boolean(update.qr) },
        'baileys connection.update',
      );

      if (update.qr) {
        const qr = update.qr;
        // Encoded once here so the webhook and the connect route both read the cached
        // PNG instead of re-encoding; notify only after it lands so a consumer keyed on
        // the raw `qr` text (the QRCODE_UPDATED dedupe key) never sees an incomplete payload.
        instance.qr = qr;
        instance.qrDataUrl = undefined;
        instance.status = 'qr';
        void QRCode.toDataURL(qr)
          .then((dataUrl) => {
            // A successful scan, disconnect, or newer QR can happen while the PNG encodes.
            if (!instances.has(instance.name) || instance.sock !== sock || instance.qr !== qr) return;
            instance.qrDataUrl = dataUrl;
            notifyUpdated(instance, 'qr');
          })
          .catch((err) => {
            logger.warn({ err, instance: instance.name }, 'qr png encode failed');
          });
      }
      if (update.connection === 'open') {
        clearQr(instance);
        instance.user = sock.user?.id;
        instance.status = 'open';
        instance.loggedOut = false;
        instance.reconnectAttempts = 0;
        notifyUpdated(instance, 'connection');
        // A change saved while connecting skipped the live push and Baileys sent the value read
        // before the socket opened; send the stored one if they differ.
        const pushes = instance.presencePushes ?? 0;
        void readSettings(db, instance.id)
          .then((settings) => {
            if (settings.alwaysOnline === alwaysOnline || instance.sock !== sock) return;
            if ((instance.presencePushes ?? 0) !== pushes) return;
            return sock.sendPresenceUpdate(settings.alwaysOnline ? 'available' : 'unavailable');
          })
          .catch((err) => {
            logger.debug({ err, instance: instance.name }, 'presence re-check failed');
          });
        // Baileys only emits group metadata after an explicit fetch on a reconnect.
        void sock.groupFetchAllParticipating().catch((err) => {
          logger.debug({ err, instance: instance.name }, 'group metadata sync failed');
        });
      } else if (update.connection === 'connecting') {
        instance.status = instance.qr ? 'qr' : 'connecting';
        notifyUpdated(instance, 'connection');
      } else if (update.connection === 'close') {
        clearQr(instance);
        instance.status = 'close';
        notifyUpdated(instance, 'connection');
        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;
        // loggedOut means the pairing is dead: keep the row so the user can re-scan or delete it.
        instance.loggedOut = statusCode === DisconnectReason.loggedOut;
        if (!instance.loggedOut && !instance.stopped) {
          const attempt = (instance.reconnectAttempts ?? 0) + 1;
          instance.reconnectAttempts = attempt;
          const delay = backoffMs(attempt, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS);
          void sleep(delay).then(() => {
            if (!instances.has(instance.name) || instance.sock !== sock || instance.stopped) return;
            connect(instance).catch(() => {
              if (instances.has(instance.name) && instance.sock === sock) {
                instance.status = 'close';
                notifyUpdated(instance, 'connection');
              }
            });
          });
        }
      }
    });
  }

  async function createInstance(name: string, options?: CreateInstanceOptions): Promise<Instance> {
    requireValidName(name);
    const existing = instances.get(name);
    if (existing) {
      if (options?.failIfExists) throw new InstanceAlreadyExistsError(name);
      return snapshot(existing);
    }

    const pending = creations.get(name);
    if (pending) {
      if (options?.failIfExists) throw new InstanceAlreadyExistsError(name);
      return pending;
    }

    const creation = (async () => {
      if (options?.failIfExists && await db.instanceRecord.findUnique({ where: { name }, select: { id: true } })) {
        throw new InstanceAlreadyExistsError(name);
      }

      const record = await db.instanceRecord.upsert({
        where: { name },
        create: { name, connectionStatus: 'connecting' },
        update: { connectionStatus: 'connecting' },
      });

      const instance: LiveInstance = { id: record.id, name, status: 'connecting' };
      instances.set(name, instance);
      emit({ type: 'created', instance: snapshot(instance) });
      await connect(instance);
      return snapshot(instance);
    })();

    creations.set(name, creation);
    try {
      return await creation;
    } finally {
      if (creations.get(name) === creation) creations.delete(name);
    }
  }

  async function restoreInstances(): Promise<void> {
    const records = await db.instanceRecord.findMany({ select: { name: true } });
    for (const name of records.map((record) => record.name).filter(isValidName).sort()) {
      await createInstance(name);
    }
  }

  return {
    listInstances(): Instance[] {
      return [...instances.values()]
        .map(snapshot)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    getInstance(name: string): Instance | undefined {
      const instance = instances.get(name);
      return instance ? snapshot(instance) : undefined;
    },

    createInstance,

    /**
         * Sends a text message and returns it in the same normalized shape as an inbound
         * one, so the API response and the stored row agree with what a webhook would carry.
         * Baileys echoes the send back through `messages.upsert`, which is what persists it.
         */
    async downloadMessageMedia(name, message) {
      const instance = instances.get(name);
      if (!instance?.sock || instance.status !== 'open' || !MEDIA_TYPES.has(message.messageType)) return undefined;
      const sock = instance.sock;
      try {
        const { downloadMediaMessage, proto } = await import('baileys');
        // fromObject restores base64-encoded protobuf byte fields (notably mediaKey).
        const raw = proto.WebMessageInfo.fromObject({ key: message.key, message: message.message }) as WAMessage;
        // Our pnpm Baileys patch forwards this signal to fetch, including body reads.
        const stream = await downloadMediaMessage(raw, 'stream', { options: { signal: AbortSignal.timeout(30000) } }, {
          logger: BAILEYS_LOGGER, reuploadRequest: sock.updateMediaMessage,
        });
        const buffer = await readMediaStream(stream);
        if (instance.sock !== sock || !buffer.length) return undefined;
        const node = raw.message?.[message.messageType as keyof NonNullable<WAMessage['message']>] as { mimetype?: string } | undefined;
        return { buffer, mimetype: node?.mimetype ?? 'application/octet-stream' };
      } catch (err) {
        logger.debug({ err, instance: name, keyId: message.key.id }, 'on-demand media download failed');
        return undefined;
      }
    },

    async getProfilePictureUrl(name: string, jid: string): Promise<string | undefined> {
      requireValidName(name);

      const instance = instances.get(name);
      if (!instance) throw new Error(`The "${name}" instance does not exist`);
      if (!instance.sock || instance.status !== 'open') throw new InstanceNotConnectedError(name);

      const recipient = toRecipientJid(jid);
      if (!recipient) throw new Error('Invalid recipient');
      return instance.sock.profilePictureUrl(recipient, 'preview');
    },

    async getBusinessProfile(name: string, jid: string): Promise<Record<string, unknown> | undefined> {
      requireValidName(name);

      const instance = instances.get(name);
      if (!instance) throw new Error(`The "${name}" instance does not exist`);
      if (!instance.sock || instance.status !== 'open') throw new InstanceNotConnectedError(name);

      const recipient = toRecipientJid(jid);
      if (!recipient) throw new Error('Invalid recipient');
      const profile = await instance.sock.getBusinessProfile(recipient);
      return profile ? (toPlainJson(profile) as Record<string, unknown>) : undefined;
    },

    async sendText(name: string, number: string, text: string, options?: SendTextOptions): Promise<InboundMessage> {
      requireValidName(name);

      const instance = instances.get(name);
      if (!instance) throw new Error(`The "${name}" instance does not exist`);
      if (!instance.sock || instance.status !== 'open') throw new InstanceNotConnectedError(name);

      const jid = toRecipientJid(number);
      if (!jid) throw new Error('Invalid recipient number');

      const context = await buildSendContext(instance.sock, db, instance.id, jid, options);

      if (options?.delay) await typeFor(instance.sock, jid, options.delay, options.presence);

      const sent = await instance.sock.sendMessage(
        jid,
        {
          text,
          ...(context.mentions ? { mentions: context.mentions } : {}),
          // Only an explicit false suppresses it; anything else keeps Baileys' default.
          // Baileys reads null as "do not generate one", where the reference passes false.
          ...(options?.linkPreview === false ? { linkPreview: null } : {}),
        },
        context.quoted ? { quoted: context.quoted } : undefined,
      );
      // The import is cached; connect() already pulled the module in.
      const { getContentType, getDevice, jidNormalizedUser } = await import('baileys');
      const message = sent && toInboundMessage(sent, { getContentType, getDevice, jidNormalizedUser }, instance.id);
      if (!message) throw new Error('WhatsApp accepted the message but returned nothing usable');

      emit({ type: 'sent', instance: snapshot(instance), message });
      return message;
    },

    async sendMedia(
      name: string,
      number: string,
      mediatype: MediaType,
      media: string,
      mimetype: string | undefined,
      options?: SendMediaOptions,
    ): Promise<InboundMessage> {
      requireValidName(name);

      const instance = instances.get(name);
      if (!instance) throw new Error(`The "${name}" instance does not exist`);
      if (!instance.sock || instance.status !== 'open') throw new InstanceNotConnectedError(name);

      const jid = toRecipientJid(number);
      if (!jid) throw new Error('Invalid recipient number');

      const { buffer, contentType, url } = await resolveMedia(media);
      const resolvedMimetype = inferMimetype({ mimetype, fileName: options?.fileName, url, contentType, mediatype, buffer });
      if (!resolvedMimetype) throw new InvalidMediaError('"mimetype" could not be inferred; send it explicitly');
      const derivedName = mediatype === 'document' && url ? fileNameFromUrl(url) : undefined;
      const fileName = options?.fileName ?? (derivedName && capFileName(withExtension(derivedName, resolvedMimetype)));
      const context = await buildSendContext(instance.sock, db, instance.id, jid, options);

      if (options?.delay) await typeFor(instance.sock, jid, options.delay, options.presence);

      const content = buildMediaContent(mediatype, buffer, resolvedMimetype, options?.caption, fileName);
      const sent = await instance.sock.sendMessage(
        jid,
        { ...content, ...(context.mentions ? { mentions: context.mentions } : {}) },
        context.quoted ? { quoted: context.quoted } : undefined,
      );
      // The import is cached; connect() already pulled the module in.
      const { getContentType, getDevice, jidNormalizedUser } = await import('baileys');
      const message = sent && toInboundMessage(sent, { getContentType, getDevice, jidNormalizedUser }, instance.id);
      if (!message) throw new Error('WhatsApp accepted the message but returned nothing usable');

      message.media = { buffer, mimetype: resolvedMimetype };

      emit({ type: 'sent', instance: snapshot(instance), message });
      return message;
    },

    async sendAudio(name: string, number: string, audio: string, options?: SendAudioOptions): Promise<InboundMessage> {
      requireValidName(name);

      const instance = instances.get(name);
      if (!instance) throw new Error(`The "${name}" instance does not exist`);
      if (!instance.sock || instance.status !== 'open') throw new InstanceNotConnectedError(name);

      const jid = toRecipientJid(number);
      if (!jid) throw new Error('Invalid recipient number');

      const { buffer } = await resolveMedia(audio, 'audio');
      const bytes = options?.encoding === false ? buffer : await transcodeToOpus(buffer, { lpcm: isLpcmSource(audio) });
      const context = await buildSendContext(instance.sock, db, instance.id, jid, options);

      // A voice note is recorded, not typed, so the presence the recipient sees differs.
      if (options?.delay) await typeFor(instance.sock, jid, options.delay, options.presence ?? 'recording');

      const sent = await instance.sock.sendMessage(
        jid,
        {
          audio: bytes,
          ptt: true,
          mimetype: OPUS_MIMETYPE,
          ...(context.mentions ? { mentions: context.mentions } : {}),
        },
        context.quoted ? { quoted: context.quoted } : undefined,
      );
      const { getContentType, getDevice, jidNormalizedUser } = await import('baileys');
      const message = sent && toInboundMessage(sent, { getContentType, getDevice, jidNormalizedUser }, instance.id);
      if (!message) throw new Error('WhatsApp accepted the message but returned nothing usable');

      emit({ type: 'sent', instance: snapshot(instance), message });
      return message;
    },

    async editMessage(name: string, input: UpdateMessageInput): Promise<Record<string, unknown>> {
      requireValidName(name);

      const instance = instances.get(name);
      if (!instance) throw new Error(`The "${name}" instance does not exist`);
      if (!instance.sock || instance.status !== 'open') throw new InstanceNotConnectedError(name);

      const jid = toRecipientJid(input.number);
      if (!jid) throw new Error('Invalid recipient number');
      if (!input.key.fromMe) throw new Error('You can only edit messages you sent');
      if (input.key.remoteJid !== jid) throw new Error('RemoteJid does not match');

      const sent = await instance.sock.sendMessage(jid, { text: input.text, edit: input.key });
      const { getContentType, getDevice, jidNormalizedUser } = await import('baileys');
      const message = sent && toEditedMessage(sent, { getContentType, getDevice, jidNormalizedUser });
      if (!message) throw new Error('WhatsApp accepted the edit but returned nothing usable');

      emit({ type: 'sent-message-update', instance: snapshot(instance), message });
      return toPlainJson(sent) as unknown as Record<string, unknown>;
    },

    async renameInstance(name: string, newName: string): Promise<void> {
      requireValidName(name);
      requireValidName(newName);
      if (name === newName) return;

      const instance = instances.get(name);
      if (!instance) return;
      if (instances.has(newName)) throw new Error('Instance name already taken');

      // The unique constraint decides, and auth state follows the stable instance id.
      try {
        await db.instanceRecord.update({ where: { id: instance.id }, data: { name: newName } });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new InstanceNameTakenError(newName);
        throw error;
      }
      const mediaFrom = join(MEDIA_DIR, name);
      if (existsSync(mediaFrom)) renameSync(mediaFrom, join(MEDIA_DIR, newName));

      instances.delete(name);
      instance.name = newName;
      instances.set(newName, instance);
      notifyUpdated(instance, 'connection');
    },

    async disconnectInstance(name: string): Promise<void> {
      requireValidName(name);
      const instance = instances.get(name);
      if (!instance) return;

      instance.stopped = true;
      clearQr(instance);
      instance.status = 'close';
      notifyUpdated(instance, 'connection');
      await instance.sock?.end(undefined);
      instance.sock = undefined;
    },

    async logoutInstance(name: string): Promise<void> {
      requireValidName(name);
      const instance = instances.get(name);
      if (!instance) return;

      instance.stopped = true;
      clearQr(instance);
      instance.status = 'close';
      instance.loggedOut = true;
      notifyUpdated(instance, 'connection');
      try {
        await instance.sock?.logout();
      } catch {
        // Never paired, or already offline; the session is wiped on the next connect either way.
      } finally {
        await instance.sock?.end(undefined);
      }
      instance.sock = undefined;
      await clearPostgresAuthState(db, instance.id);
    },

    async reconnectInstance(name: string): Promise<void> {
      requireValidName(name);
      const pending = reconnects.get(name);
      if (pending) return pending;

      const instance = instances.get(name);
      if (!instance || instance.status !== 'close') return;

      // Publish the transition before awaiting shutdown, so duplicate connect requests
      // cannot each create a socket. The promise below also coalesces later callers.
      instance.status = 'connecting';
      clearQr(instance);
      instance.stopped = true;
      notifyUpdated(instance, 'connection');
      const reconnect = (async () => {
        // Prevent the intentionally ended socket from scheduling its own reconnect.
        await instance.sock?.end(undefined);
        instance.stopped = false;
        // A logged-out pairing is dead; remove its auth state so Baileys issues a fresh QR.
        if (instance.loggedOut) {
          await clearPostgresAuthState(db, instance.id);
          instance.loggedOut = false;
        }
        await connect(instance);
      })();
      reconnects.set(name, reconnect);
      try {
        await reconnect;
      } finally {
        if (reconnects.get(name) === reconnect) reconnects.delete(name);
      }
    },

    async setOnlinePresence(name: string, online: boolean): Promise<void> {
      const instance = instances.get(name);
      if (!instance?.sock || instance.status !== 'open') return;
      instance.presencePushes = (instance.presencePushes ?? 0) + 1;
      try {
        await instance.sock.sendPresenceUpdate(online ? 'available' : 'unavailable');
      } catch (err) {
        // The next connect applies the stored setting anyway.
        logger.warn({ err, instance: name }, 'presence update failed');
      }
    },

    async deleteInstance(name: string): Promise<void> {
      requireValidName(name);
      const instance = instances.get(name);
      instances.delete(name);
      if (instance) {
        instance.stopped = true;
        emit({ type: 'deleted', name });
      }
      try {
        await instance?.sock?.logout();
      } catch {
        // Never paired, or already offline; the record cascade clears auth state either way.
      } finally {
        // logout() ends the socket itself, but not when the unpair request fails.
        await instance?.sock?.end(undefined);
      }
      // deleteMany keeps this idempotent; the cascade drops auth state, webhooks, chats, and messages.
      await db.instanceRecord.deleteMany({ where: { name } });
      rmSync(join(MEDIA_DIR, name), { recursive: true, force: true });
    },

    restoreInstances,

    subscribe(listener: InstanceEventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
