import { randomUUID } from 'node:crypto';
import type { EvolutionConnectionState, EvolutionEvent } from './contracts/evolution';
import type { EditedMessage, InboundMessage, Instance, InstanceEvent, MessageUpdate } from './instances';

/**
 * A domain occurrence, already carrying the Evolution `data` payload but not yet an
 * envelope. Baileys objects never travel past this boundary.
 */
export type DomainEvent = {
  /** Correlation id; becomes the delivery id sent to the consumer. */
  id: string;
  occurredAt: Date;
  event: EvolutionEvent;
  instanceId: string;
  instanceName: string;
  /** Envelope `data`. */
  data: unknown;
  /** Envelope `sender`: the paired WhatsApp id, absent until the instance pairs. */
  sender?: string;
  /** Collapses repeated deliveries of the same occurrence into one outbox row. */
  dedupeKey: string;
  media?: InboundMessage['media'];
};

/** Our statuses carry the QR step; the reference reports Baileys connection states. */
export const CONNECTION_STATES: Record<Instance['status'], EvolutionConnectionState> = {
  connecting: 'connecting',
  qr: 'connecting',
  open: 'open',
  close: 'close',
};

function base(instance: Instance, event: EvolutionEvent, data: unknown, dedupeKey: string): DomainEvent {
  return {
    id: randomUUID(),
    occurredAt: new Date(),
    event,
    instanceId: instance.id,
    instanceName: instance.name,
    data,
    sender: instance.user,
    dedupeKey,
  };
}

/**
 * Maps an instance lifecycle change to the events consumers subscribe to. Returns an
 * array because one change can be worth more than one event.
 *
 * Payload gaps against the reference, needing data we do not collect yet:
 * `profileName`/`profilePictureUrl`/`statusReason` on connection updates.
 */
export function toDomainEvents(event: InstanceEvent): DomainEvent[] {
  if (event.type === 'deleted') return [];
  // Messages publish only once they are stored, so `src/messages.ts` maps them instead.
  if (
    event.type === 'messages' ||
        event.type === 'message-edited' ||
        event.type === 'message-updated' ||
        event.type === 'message-deleted'
  ) return [];
  // A send is already confirmed by WhatsApp, and its row arrives on its own through the
  // `messages.upsert` echo, so nothing here has to wait for a write.
  if (event.type === 'sent') return [toMessageEvent(event.instance, event.message, 'SEND_MESSAGE')];
  if (event.type === 'sent-message-update') return [toMessageEditedEvent(event.instance, event.message, 'SEND_MESSAGE_UPDATE')];
  // Chat names have no webhook event, so they must not fall through and fire a spurious
  // CONNECTION_UPDATE.
  if (event.type === 'groups' || event.type === 'contacts' || event.type === 'history' || event.type === 'chat-alias') return [];

  const { instance } = event;

  if (event.type === 'updated' && event.change === 'qr') {
    if (!instance.qr) return [];
    return [
      base(
        instance,
        'QRCODE_UPDATED',
        { qrcode: { instance: instance.name, pairingCode: null, code: instance.qr, base64: instance.qrDataUrl } },
        // The same QR re-emitted must not enqueue twice.
        `QRCODE_UPDATED:${instance.id}:${instance.qr}`,
      ),
    ];
  }

  const data: Record<string, unknown> = {
    instance: instance.name,
    state: CONNECTION_STATES[instance.status],
  };
  if (instance.user) data.wuid = instance.user;

  const event_ = base(instance, 'CONNECTION_UPDATE', data, '');
  // ponytail: a state transition has no natural key, so the correlation id is the
  // dedupe key. Two identical transitions enqueue twice; give it a real key if a
  // reconnect loop is ever seen duplicating deliveries.
  return [{ ...event_, dedupeKey: `CONNECTION_UPDATE:${instance.id}:${event_.id}` }];
}

/** Maps a Baileys receipt/status change to the reference MESSAGES_UPDATE payload. */
/** Maps an edit's raw protocol payload to either inbound or outbound edit events. */
export function toMessageEditedEvent(
  instance: Instance,
  message: EditedMessage,
  event: 'MESSAGES_EDITED' | 'SEND_MESSAGE_UPDATE' = 'MESSAGES_EDITED',
): DomainEvent {
  return base(
    instance,
    event,
    message.data,
    `${event}:${instance.id}:${message.key.remoteJid}:${message.key.fromMe}:${message.key.id}:${JSON.stringify(message.data)}`,
  );
}

export function toMessageUpdateEvent(instance: Instance, update: MessageUpdate): DomainEvent {
  return base(
    instance,
    'MESSAGES_UPDATE',
    {
      keyId: update.key.id,
      remoteJid: update.key.remoteJid,
      fromMe: update.key.fromMe,
      ...(update.key.participant ? { participant: update.key.participant } : {}),
      status: update.status,
      instanceId: instance.id,
    },
    `MESSAGES_UPDATE:${instance.id}:${update.key.remoteJid}:${update.key.fromMe}:${update.key.id}:${update.status}`,
  );
}

/** The pinned reference's messages.update revoke path spreads the key, rather than nesting it. */
export function toMessageDeleteEvent(instance: Instance, key: InboundMessage['key']): DomainEvent {
  return base(
    instance,
    'MESSAGES_DELETE',
    { ...key, status: 'DELETED' },
    `MESSAGES_DELETE:${instance.id}:${key.remoteJid}:${key.fromMe}:${key.id}`,
  );
}

/**
 * Maps one stored message to its webhook event. Called after persistence, never from the
 * socket callback, so a consumer never sees a message we failed to store.
 */
export function toMessageEvent(
  instance: Instance,
  message: InboundMessage,
  event: 'MESSAGES_UPSERT' | 'SEND_MESSAGE' | 'STATUS_UPDATE' = 'MESSAGES_UPSERT',
): DomainEvent {
  const occurrence = base(
    instance,
    event,
    {
      key: message.key,
      pushName: message.pushName,
      message: message.message,
      contextInfo: message.contextInfo,
      messageType: message.messageType,
      messageTimestamp: message.messageTimestamp,
      instanceId: instance.id,
      source: message.source,
      status: message.status,
    },
    // The WhatsApp message key is a natural key, so a replayed upsert enqueues once.
    `${event}:${instance.id}:${message.key.remoteJid}:${message.key.fromMe}:${message.key.id}`,
  );
  return message.media ? { ...occurrence, media: message.media } : occurrence;
}
