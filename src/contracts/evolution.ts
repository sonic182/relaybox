/**
 * The only place Evolution API shapes are encoded. Mirrors the local
 * `./evolution-api` 2.4.0 reference (commit e273b904) without importing from it.
 */

/** Reference-compatible event families; the empty subscription default selects these only. */
export const SUPPORTED_EVENTS = [
  'QRCODE_UPDATED',
  'CONNECTION_UPDATE',
  'MESSAGES_UPSERT',
  'MESSAGES_EDITED',
  'MESSAGES_UPDATE',
  'MESSAGES_DELETE',
  'SEND_MESSAGE',
  'SEND_MESSAGE_UPDATE',
] as const;

/** Explicit project extensions, deliberately excluded from the catch-all subscription default. */
export const EXTENSION_EVENTS = ['STATUS_UPDATE'] as const;

/** Every event consumers may explicitly select in a webhook configuration. */
export const WEBHOOK_EVENTS = [...SUPPORTED_EVENTS, ...EXTENSION_EVENTS] as const;

export type EvolutionEvent = (typeof WEBHOOK_EVENTS)[number];

export function isSupportedEvent(value: unknown): value is EvolutionEvent {
  return typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** `MESSAGES_UPSERT` -> `messages.upsert`, the name delivered inside the envelope. */
export function toEventName(event: EvolutionEvent): string {
  return event.replace(/_/g, '.').toLowerCase();
}

/** `MESSAGES_UPSERT` -> `messages-upsert`, the `byEvents` URL suffix. */
export function toEventPath(event: EvolutionEvent): string {
  return event.replace(/_/g, '-').toLowerCase();
}

/** Request body of `POST /webhook/set/:instanceName`. */
export type WebhookConfigInput = {
  webhook: {
    url: string;
    /** Defaults to true. */
    enabled?: boolean;
    /** Omitted keeps the stored headers; null clears them. */
    headers?: Record<string, string> | null;
    /**
     * Optional HMAC secret for the `X-Webhook-Signature` delivery header (extra field,
     * not in the reference API). Omitted keeps the stored value; null or empty disables
     * signing. Consumers verify with `sha256=<hex HMAC>` of the raw body.
     */
    signatureSecret?: string | null;
    /** Whether deliveries include the `X-Webhook-Signature` header. Defaults to false without a secret. */
    signatureEnabled?: boolean;
    byEvents?: boolean;
    base64?: boolean;
    /** Empty or omitted while enabled subscribes to every supported event. */
    events?: EvolutionEvent[];
  };
};

/**
 * Stored configuration as returned by `POST /webhook/set` and `GET /webhook/find`.
 * The reference returns the database row, so responses use `webhookByEvents`/
 * `webhookBase64` while the request uses `byEvents`/`base64`.
 */
export type WebhookConfigResponse = {
  id: string;
  url: string;
  headers: Record<string, string> | null;
  /** Whether a signing secret is stored. The secret is write-only. */
  hasSignatureSecret: boolean;
  /** Whether deliveries are currently signed with the stored secret. */
  signatureEnabled: boolean;
  enabled: boolean;
  events: EvolutionEvent[];
  webhookByEvents: boolean;
  webhookBase64: boolean;
  createdAt: string;
  updatedAt: string;
  instanceId: string;
};

/**
 * The reference settings implemented. Unlike the reference, `syncFullHistory: false` ignores the
 * history WhatsApp sends while pairing instead of still receiving the recent history.
 */
export type Settings = {
  syncFullHistory: boolean;
  alwaysOnline: boolean;
};

/**
 * `POST /settings/set` body. The reference requires every setting; here each is optional and
 * an omitted one keeps its stored value, so clients that only know `syncFullHistory` still work.
 */
export type SettingsInput = Partial<Settings>;

/** `GET /settings/find` returns the settings flat, as the reference does. */
export type SettingsResponse = Settings;

/** `POST /settings/set` echoes the stored settings under the instance name, as the reference does. */
export type SettingsSetResponse = {
  settings: { instanceName: string; settings: Settings };
};

/** Baileys presence values; shown to the recipient during a send `delay`. */
export type WAPresence = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';

/** The message a send replies to; `message` is optional when we already stored it. */
export type QuotedMessage = {
  key: { id: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  message?: Record<string, unknown>;
};

/**
 * Context fields the reference carries on every send DTO through its `Metadata` base class.
 * Mentions apply to group recipients only, as they do in the reference.
 */
export type SendContextInput = {
  /** Reply to this message; unresolvable keys send unquoted, as the reference does. */
  quoted?: QuotedMessage;
  /** Numbers or JIDs to mention. Ignored outside a group. */
  mentioned?: string[];
  /** Mention every participant of the group. Takes precedence over `mentioned`. */
  mentionsEveryOne?: boolean;
};

/** Request body of `POST /message/sendText/:instanceName`. */
export type SendTextInput = SendContextInput & {
  /** A bare number or a qualified JID; a group JID sends to the group. */
  number: string;
  text: string;
  /** Simulate typing for this many milliseconds before delivering; the presence shows `composing` then `paused`. */
  delay?: number;
  /** Presence shown during `delay`; default `composing`. */
  presence?: WAPresence;
  /** `false` suppresses the link preview; only text messages carry one. */
  linkPreview?: boolean;
};

/** `sendMedia` message kinds; stickers have their own planned endpoint. */
export type MediaType = 'image' | 'video' | 'document' | 'audio';

/** Request body of `POST /message/sendMedia/:instanceName`. */
export type SendMediaInput = SendContextInput & {
  /** A bare number or a qualified JID; a group JID sends to the group. */
  number: string;
  mediatype: MediaType;
  /** An `http(s)` URL the server fetches, or a base64-encoded payload. */
  media: string;
  /** Inferred from `fileName`, the URL, its `content-type`, or the payload's leading bytes when omitted. */
  mimetype?: string;
  caption?: string;
  fileName?: string;
  /** Simulate typing for this many milliseconds before delivering. */
  delay?: number;
  /** Presence shown during `delay`; default `composing`. */
  presence?: WAPresence;
};

/**
 * Request body of `POST /message/sendWhatsAppAudio/:instanceName`, which sends a push-to-talk
 * voice note rather than the file-style bubble `sendMedia` produces for `mediatype: 'audio'`.
 */
export type SendAudioInput = SendContextInput & {
  /** A bare number or a qualified JID; a group JID sends to the group. */
  number: string;
  /** An `http(s)` URL the server fetches, a base64 payload, or a multipart `file` upload. */
  audio: string;
  /** Transcode to ogg/opus before sending; default true, as the reference defaults it. */
  encoding?: boolean;
  /** Simulate recording for this many milliseconds before delivering. */
  delay?: number;
  /** Presence shown during `delay`; default `recording`. */
  presence?: WAPresence;
};

/** Request body of `POST /chat/updateMessage/:instanceName`. */
export type UpdateMessageInput = SendTextInput & {
  key: { id: string; remoteJid: string; fromMe: boolean; participant?: string };
};

/** Baileys connection states, as the reference reports them. */
export type EvolutionConnectionState = 'open' | 'close' | 'connecting';

/** Response of `GET /instance/connectionState/:instanceName`. */
export type ConnectionStateResponse = {
  instance: { instanceName: string; state: EvolutionConnectionState };
};

/** Response of `GET /instance/connect/:instanceName`. */
export type ConnectResponse = ConnectionStateResponse | { base64: string };

export type InstanceQrCode = {
  base64?: string;
  code?: string;
};

export type InstanceCreateInput = {
  instanceName: string;
  qrcode?: boolean;
  integration?: 'WHATSAPP-BAILEYS';
  webhook?: WebhookConfigInput['webhook'];
  syncFullHistory?: boolean;
};

export type InstanceListItem = {
  id: string;
  name: string;
  connectionStatus: EvolutionConnectionState;
  ownerJid?: string;
};

export type InstanceOperationResponse = {
  instance: {
    instanceName: string;
    instanceId: string;
    integration: 'WHATSAPP-BAILEYS';
    status: EvolutionConnectionState;
  };
  qrcode?: InstanceQrCode;
};

export type WebhookEnvelope = {
  event: string;
  instance: string;
  data: unknown;
  destination: string;
  date_time: string;
  sender?: string;
  server_url: string;
  apikey: string;
};

export type EnvelopeInput = {
  event: EvolutionEvent;
  instance: string;
  data: unknown;
  destination: string;
  dateTime: string;
  serverUrl: string;
  apikey: string;
  sender?: string;
  /** Event-specific extra fields; the reference spreads these before the fixed keys. */
  extra?: Record<string, unknown>;
};

export function buildEnvelope({
  event,
  instance,
  data,
  destination,
  dateTime,
  serverUrl,
  apikey,
  sender,
  extra,
}: EnvelopeInput): WebhookEnvelope {
  return {
    ...(extra ?? {}),
    event: toEventName(event),
    instance,
    data,
    destination,
    date_time: dateTime,
    sender,
    server_url: serverUrl,
    apikey,
  };
}

export type ApiErrorBody = {
  status: number;
  error: string;
  response: { message: string | string[] };
};

export function apiErrorBody(status: number, error: string, message: string | string[]): ApiErrorBody {
  return { status, error, response: { message } };
}
