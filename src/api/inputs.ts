import type { ChatService } from '../chats';
import type {
  MediaType,
  SendAudioInput,
  SendContextInput,
  SendMediaInput,
  SendTextInput,
  UpdateMessageInput,
  WAPresence,
} from '../contracts/evolution';
import { toRecipientJid } from '../instances';
import { badRequest } from './errors';

/** Presence values accepted by every send; shared by the HTTP readers and the MCP schemas. */
export const PRESENCES = ['unavailable', 'available', 'composing', 'recording', 'paused'] as const satisfies readonly WAPresence[];

/** Message kinds `sendMedia` accepts; shared by the HTTP readers and the MCP schemas. */
export const MEDIA_TYPES = ['image', 'video', 'document', 'audio'] as const satisfies readonly MediaType[];

function validateRecipient(number: unknown, errors: string[]): void {
  if (typeof number !== 'string' || !number.trim()) errors.push('"number" is required');
  else if (!toRecipientJid(number)) errors.push('"number" must contain digits or a qualified JID');
}

function validateSendOptions(delay: number | undefined, presence: WAPresence | undefined, errors: string[]): void {
  if (delay !== undefined && (!Number.isInteger(delay) || delay < 0)) errors.push('"delay" must be a non-negative integer');
  if (presence !== undefined && !PRESENCES.includes(presence)) {
    errors.push('"presence" must be one of: composing, recording, paused, available, unavailable');
  }
}

/**
 * The context fields the reference carries on every send through its `Metadata` base class.
 * Shared by all three readers so a caller does not have to learn which endpoint honours what.
 */
function readSendContext(body: unknown, errors: string[]): SendContextInput {
  const { quoted, mentioned, mentionsEveryOne } = (body ?? {}) as Partial<SendContextInput>;
  const context: SendContextInput = {};

  if (quoted !== undefined) {
    // The body is optional — we look the message up by key — but the id never is.
    const id = quoted?.key?.id;
    if (typeof id !== 'string' || !id.trim()) errors.push('"quoted.key.id" is required when "quoted" is present');
    else context.quoted = quoted;
  }

  if (mentioned !== undefined) {
    if (!Array.isArray(mentioned) || mentioned.some((mention) => typeof mention !== 'string')) {
      errors.push('"mentioned" must be an array of strings');
    } else context.mentioned = mentioned;
  }

  if (mentionsEveryOne !== undefined) {
    if (typeof mentionsEveryOne !== 'boolean') errors.push('"mentionsEveryOne" must be a boolean');
    else context.mentionsEveryOne = mentionsEveryOne;
  }

  return context;
}

export function readSendText(body: unknown): SendTextInput {
  const { number, text, delay, presence, linkPreview } = (body ?? {}) as Partial<SendTextInput>;
  const errors: string[] = [];

  validateRecipient(number, errors);
  // The reference rejects whitespace-only text rather than sending an empty bubble.
  if (typeof text !== 'string' || !text.trim()) errors.push('"text" is required');
  if (linkPreview !== undefined && typeof linkPreview !== 'boolean') errors.push('"linkPreview" must be a boolean');
  validateSendOptions(delay, presence, errors);
  const context = readSendContext(body, errors);
  if (errors.length) throw badRequest(errors);

  const input: SendTextInput = { number: number as string, text: text as string, ...context };
  if (delay !== undefined) input.delay = delay;
  if (presence !== undefined) input.presence = presence;
  if (linkPreview !== undefined) input.linkPreview = linkPreview;
  return input;
}

export function readSendMedia(body: unknown): SendMediaInput {
  const { number, mediatype, media, mimetype, caption, fileName, delay, presence } = (body ?? {}) as Partial<SendMediaInput>;
  const errors: string[] = [];

  validateRecipient(number, errors);
  if (typeof mediatype !== 'string' || !MEDIA_TYPES.includes(mediatype as MediaType)) {
    errors.push(`"mediatype" must be one of: ${MEDIA_TYPES.join(', ')}`);
  }
  if (typeof media !== 'string' || !media.trim()) errors.push('"media" is required');
  // null and blank mean "infer it", as they do for the reference; anything else must be a string.
  if (mimetype !== undefined && mimetype !== null && typeof mimetype !== 'string') errors.push('"mimetype" must be a string');
  if (caption !== undefined && typeof caption !== 'string') errors.push('"caption" must be a string');
  if (fileName !== undefined && typeof fileName !== 'string') errors.push('"fileName" must be a string');
  validateSendOptions(delay, presence, errors);
  const context = readSendContext(body, errors);
  if (errors.length) throw badRequest(errors);

  const input: SendMediaInput = {
    number: number as string,
    mediatype: mediatype as MediaType,
    media: media as string,
    ...context,
  };
  if (typeof mimetype === 'string' && mimetype.trim()) input.mimetype = mimetype;
  if (caption !== undefined) input.caption = caption;
  if (fileName !== undefined) input.fileName = fileName;
  if (delay !== undefined) input.delay = delay;
  if (presence !== undefined) input.presence = presence;
  return input;
}

/**
 * A multipart field arrives as a string, so `delay=1200` and `encoding=false` would fail the
 * checks a JSON body passes. Coerce only the two typed fields, and only for multipart, so a
 * JSON caller still gets told that `"1200"` is not an integer.
 */
function coerceMultipartFields(body: Record<string, unknown>): Record<string, unknown> {
  const { delay, encoding } = body;
  return {
    ...body,
    ...(typeof delay === 'string' && /^\d+$/.test(delay) ? { delay: Number(delay) } : {}),
    ...(encoding === 'true' || encoding === 'false' ? { encoding: encoding === 'true' } : {}),
  };
}

export function readSendAudio(body: unknown, file: Express.Multer.File | undefined, multipart: boolean): SendAudioInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const { number, audio, encoding, delay, presence } = (multipart ? coerceMultipartFields(raw) : raw) as Partial<SendAudioInput>;
  const errors: string[] = [];

  validateRecipient(number, errors);
  // An uploaded file is the audio, so it stands in for the field rather than competing with it.
  const source = file ? file.buffer.toString('base64') : audio;
  if (typeof source !== 'string' || !source.trim()) errors.push('"audio" is required, as a url, base64 payload, or uploaded file');
  if (encoding !== undefined && typeof encoding !== 'boolean') errors.push('"encoding" must be a boolean');
  validateSendOptions(delay, presence, errors);
  const context = readSendContext(raw, errors);
  if (errors.length) throw badRequest(errors);

  const input: SendAudioInput = { number: number as string, audio: source as string, ...context };
  if (encoding !== undefined) input.encoding = encoding;
  if (delay !== undefined) input.delay = delay;
  if (presence !== undefined) input.presence = presence;
  return input;
}

/** The options every send shares, so one endpoint cannot quietly drop a field another honours. */
export function sendOptions(input: SendContextInput & { delay?: number; presence?: WAPresence }) {
  return {
    delay: input.delay,
    presence: input.presence,
    quoted: input.quoted,
    mentioned: input.mentioned,
    mentionsEveryOne: input.mentionsEveryOne,
  };
}

export function readUpdateMessage(body: unknown): UpdateMessageInput {
  const { number, text, key } = (body ?? {}) as Partial<UpdateMessageInput>;
  const errors: string[] = [];

  if (typeof number !== 'string' || !number.trim()) errors.push('"number" is required');
  if (typeof text !== 'string' || !text.trim()) errors.push('"text" is required');
  if (!key || typeof key !== 'object') {
    errors.push('"key" is required');
  } else {
    if (typeof key.id !== 'string' || !key.id.trim()) errors.push('"key.id" is required');
    if (typeof key.remoteJid !== 'string' || !key.remoteJid.trim()) errors.push('"key.remoteJid" is required');
    if (typeof key.fromMe !== 'boolean') errors.push('"key.fromMe" is required');
    else if (!key.fromMe) errors.push('You can only edit messages you sent');
    if (key.participant !== undefined && typeof key.participant !== 'string') {
      errors.push('"key.participant" must be a string');
    }
  }
  if (!errors.length) {
    const jid = toRecipientJid(number as string);
    if (!jid) errors.push('"number" must contain digits or a qualified JID');
    else if (key?.remoteJid !== jid) errors.push('RemoteJid does not match');
  }
  if (errors.length) throw badRequest(errors);

  return { number: number as string, text: text as string, key: key as UpdateMessageInput['key'] };
}

export function readKeyId(body: unknown, field: 'message' | 'where'): string {
  const key = ((body as Record<string, unknown> | null)?.[field] as { key?: unknown } | null)?.key;
  const id = (key as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id.trim()) throw badRequest(`"${field}.key.id" is required`);
  return id.trim();
}

export function readConvertToMp4(body: unknown): void {
  const value = (body as Record<string, unknown> | null)?.convertToMp4;
  if (value === undefined || value === false) return;
  if (value !== true) throw badRequest('"convertToMp4" must be a boolean');
  throw badRequest('"convertToMp4" is not supported');
}

type FoundMessage = Awaited<ReturnType<ChatService['findMessage']>>;

/** The `findMessages` envelope, shared by the HTTP route and the MCP tool. */
export function findMessagesResponse(instanceId: string, found: FoundMessage) {
  return {
    messages: {
      records: found
        ? [
          {
            key: found.key,
            pushName: found.pushName,
            message: found.message,
            contextInfo: found.contextInfo,
            messageType: found.messageType,
            messageTimestamp: found.messageTimestamp,
            // Same shape a send returns, so a consumer reads one message format.
            instanceId,
            status: found.status,
          },
        ]
        : [],
    },
  };
}
