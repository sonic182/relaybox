import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '@zenstackhq/orm';
import type { Logger } from 'pino';
import type { Db } from './db';
import { toMessageDeleteEvent, toMessageEditedEvent, toMessageEvent, toMessageUpdateEvent } from './events';
import {
  MEDIA_DIR,
  type ContactSummary,
  type EditedMessage,
  type GroupSummary,
  type InboundMessage,
  type Instance,
  type InstanceEvent,
  type InstanceService,
  type MessageUpdate,
} from './instances';
import type { Outbox } from './outbox';
import { isChatAlias, loadChatAliases, reconcileChatAlias, type ChatAlias } from './chatIdentity';

type MessageServiceOptions = {
  db: Db;
  outbox: Outbox;
  logger: Logger;
};

/**
 * The WhatsApp message key, which is what makes ingestion idempotent. The chat jid is
 * deliberately absent: a receipt or revoke can arrive keyed by the LID form while the row
 * was stored under the phone-number form, so jid must not filter the lookup.
 */
function findByMessageKey(instance: Instance, message: { key: InboundMessage['key'] }) {
  return { instanceId: instance.id, fromMe: message.key.fromMe, keyId: message.key.id };
}

/** Chat-list preview: the text when there is one, otherwise the kind of message. */
function preview(message: InboundMessage): string {
  const text = message.message.conversation;
  return typeof text === 'string' && text ? text.slice(0, 120) : `[${message.messageType}]`;
}

const HISTORY_BATCH = 500;

/** Receipt progression; a duplicate echo must never step a delivery backwards. */
const RECEIPT_RANK: Record<string, number> = {
  ERROR: 0,
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5,
};

/** Only tracked receipts may advance; DELETED/EDITED and absent statuses never do. */
function isReceiptStatus(status: string | null | undefined): status is string {
  return typeof status === 'string' && status in RECEIPT_RANK;
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

/** The file extension for a mimetype; unknown types get a neutral one. */
export function mediaExtension(mimetype: string): string {
  const type = mimetype.split(';')[0].trim().toLowerCase();
  return Object.hasOwn(MEDIA_EXTENSIONS, type) ? MEDIA_EXTENSIONS[type] : '.bin';
}

/**
 * Persists messages and only then publishes incoming ones. Owns no HTTP and no socket: it
 * consumes instance events and hands finished occurrences to the outbox.
 */
export function createMessageService({ db, outbox, logger }: MessageServiceOptions) {
  const chains = new Map<string, Promise<void>>();
  // Sync names can arrive before their first message; retain them until projection creates
  // the chat row instead of dropping an updateMany() that matched nothing.
  const chatNames = new Map<string, string>();

  function nameKey(instance: Instance, remoteJid: string): string {
    return `${instance.id}:${remoteJid}`;
  }

  function serialize(instance: Instance, work: () => Promise<void>): Promise<void> {
    const previous = chains.get(instance.id) ?? Promise.resolve();
    const next = previous.then(work, work).catch((err: unknown) => {
      logger.error({ err, instance: instance.name }, 'failed to handle message event');
    });
    chains.set(instance.id, next);
    void next.then(() => {
      if (chains.get(instance.id) === next) chains.delete(instance.id);
    });
    return next;
  }

  async function reconcileAlias(instance: Instance, alias: ChatAlias): Promise<void> {
    const result = await reconcileChatAlias(db, instance.id, alias, true);
    if (result.action === 'blocked') {
      logger.warn({ instance: instance.name, reason: result.reason }, 'chat alias merge blocked');
      return;
    }
    const sourceName = chatNames.get(nameKey(instance, alias.lid));
    if (sourceName && !chatNames.has(nameKey(instance, alias.pn))) chatNames.set(nameKey(instance, alias.pn), sourceName);
    chatNames.delete(nameKey(instance, alias.lid));
  }

  /** False when this message key is already stored, which makes a replayed batch free. */
  async function store(instance: Instance, message: InboundMessage): Promise<string | undefined> {
    try {
      const created = await db.message.create({
        data: {
          instanceId: instance.id,
          keyId: message.key.id,
          remoteJid: message.key.remoteJid,
          fromMe: message.key.fromMe,
          participant: message.key.participant ?? null,
          pushName: message.pushName ?? null,
          messageType: message.messageType,
          messageTimestamp: message.messageTimestamp,
          status: message.status ?? null,
          content: message.message as JsonObject,
          ...(message.contextInfo ? { contextInfo: message.contextInfo as JsonObject } : {}),
        },
      });
      return created.id;
    } catch (err) {
      // A duplicate is the expected failure and is silent, but anything else just lost
      // a message, so check which one it was rather than assuming.
      const stored = await db.message
        .findFirst({ where: findByMessageKey(instance, message), select: { id: true, status: true } })
        .catch(() => null);

      // A replayed echo can carry a newer receipt than the row it duplicates
      // (PENDING → SERVER_ACK); advance it, but never step a receipt backwards or
      // touch a revoke/edit that already landed.
      const incoming = message.status;
      if (
        stored &&
                isReceiptStatus(incoming) &&
                isReceiptStatus(stored.status) &&
                RECEIPT_RANK[incoming] > RECEIPT_RANK[stored.status]
      ) {
        await db.message.update({ where: { id: stored.id }, data: { status: incoming } });
      }

      if (!stored) logger.error({ err, keyId: message.key.id }, 'failed to store message');

      return undefined;
    }
  }

  /** Writes downloaded bytes to the media directory and maps the file onto the message row. */
  async function persistMedia(messageId: string, instance: Instance, message: InboundMessage): Promise<void> {
    const media = message.media;
    if (!media) return;

    const directory = join(MEDIA_DIR, instance.name);
    mkdirSync(directory, { recursive: true });
    // Only the filename is stored: the instance folder is resolved on serve, so a
    // renamed instance keeps its row valid (the folder moves with the rename).
    const path = `${randomUUID()}${mediaExtension(media.mimetype)}`;
    writeFileSync(join(directory, path), media.buffer, { flag: 'wx' });
    await db.media.create({ data: { messageId, path, mimetype: media.mimetype, size: media.buffer.length } });
  }

  async function projectChat(instance: Instance, message: InboundMessage): Promise<void> {
    const { remoteJid } = message.key;
    // Status updates are not a conversation, so they get no row in the chat list.
    if (remoteJid === 'status@broadcast') return;

    const lastMessageAt = new Date(message.messageTimestamp * 1000);
    // WhatsApp sends a direct sender's profile name with the message. Group push names
    // belong to whichever participant spoke, so only group metadata can name those chats.
    const profileName = !message.key.fromMe && !remoteJid.endsWith('@g.us') ? message.pushName?.trim() : undefined;
    await db.chat.upsert({
      where: { instanceId_remoteJid: { instanceId: instance.id, remoteJid: message.key.remoteJid } },
      create: {
        instanceId: instance.id,
        remoteJid: message.key.remoteJid,
        name: chatNames.get(nameKey(instance, remoteJid)) ?? profileName ?? null,
        lastMessageAt,
        lastMessagePreview: preview(message),
      },
      // The conditional updates below own every field an existing chat can change.
      update: {},
    });
    if (profileName) {
      await db.chat.updateMany({
        where: { instanceId: instance.id, remoteJid, name: null },
        data: { name: profileName },
      });
    }

    // Backfill arrives out of order, so an older message must not become the preview.
    await db.chat.updateMany({
      where: {
        instanceId: instance.id,
        remoteJid: message.key.remoteJid,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: lastMessageAt } }],
      },
      data: { lastMessageAt, lastMessagePreview: preview(message) },
    });
  }

  async function refreshChat(instance: Instance, remoteJid: string): Promise<void> {
    const latest = await db.message.findFirst({
      where: {
        instanceId: instance.id,
        remoteJid,
        OR: [{ status: null }, { status: { not: 'DELETED' } }],
      },
      select: { messageTimestamp: true, messageType: true, content: true },
      orderBy: { messageTimestamp: 'desc' },
    });
    const content = latest?.content as { conversation?: unknown } | undefined;
    const lastMessagePreview = latest
      ? typeof content?.conversation === 'string' && content.conversation
        ? content.conversation.slice(0, 120)
        : `[${latest.messageType}]`
      : null;

    await db.chat.updateMany({
      where: { instanceId: instance.id, remoteJid },
      data: {
        lastMessageAt: latest ? new Date(latest.messageTimestamp * 1000) : null,
        lastMessagePreview,
      },
    });
  }

  async function editMessage(instance: Instance, message: EditedMessage): Promise<void> {
    const stored = await db.message.findFirst({
      where: findByMessageKey(instance, { key: message.key }),
      select: { id: true, messageTimestamp: true, status: true, remoteJid: true },
    });
    // A late edit must not resurrect content the user revoked; the webhook still fires.
    if (stored && stored.status !== 'DELETED') {
      await db.message.update({
        where: { id: stored.id },
        data: {
          content: message.message as JsonObject,
          messageType: message.messageType,
          messageTimestamp: message.messageTimestamp || stored.messageTimestamp,
          status: 'EDITED',
        },
      });
      // Refresh the chat the row actually lives under; the edit key may be the LID form.
      await refreshChat(instance, stored.remoteJid);
    }
    await outbox.enqueue(toMessageEditedEvent(instance, message));
  }

  async function updateMessage(instance: Instance, update: MessageUpdate): Promise<void> {
    const stored = await db.message.findFirst({ where: findByMessageKey(instance, update), select: { id: true, status: true } });
    // A late receipt must not resurrect content the user revoked.
    if (stored && stored.status !== 'DELETED') {
      const incoming = update.status;
      if (
        !isReceiptStatus(incoming) ||
                !isReceiptStatus(stored.status) ||
                RECEIPT_RANK[incoming] > RECEIPT_RANK[stored.status]
      ) {
        await db.message.update({ where: { id: stored.id }, data: { status: update.status } });
      }
    }
    await outbox.enqueue(toMessageUpdateEvent(instance, update));
  }

  async function deleteMessage(instance: Instance, messageKey: InboundMessage['key']): Promise<void> {
    const stored = await db.message.findFirst({
      where: findByMessageKey(instance, { key: messageKey }),
      select: { id: true, remoteJid: true },
    });
    if (stored) {
      await db.message.update({ where: { id: stored.id }, data: { status: 'DELETED' } });
      // Refresh the chat the row actually lives under; the revoke key may be the LID form.
      await refreshChat(instance, stored.remoteJid);
    }
    await outbox.enqueue(toMessageDeleteEvent(instance, messageKey));
  }

  /** Stores and projects messages; incoming ones are also published. A failure drops only that message. */
  async function ingest(
    instance: Instance, messages: InboundMessage[], publish = true, withMedia = true,
  ): Promise<void> {
    const aliases = await loadChatAliases(db, instance.id);
    const reconciled = new Set<string>();
    for (const original of messages) {
      try {
        const { remoteJid, remoteJidAlt } = original.key;
        const explicit = remoteJidAlt ? { lid: remoteJidAlt, pn: remoteJid } : undefined;
        if (explicit && isChatAlias(explicit)) aliases.set(explicit.lid, explicit.pn);
        const lid = aliases.has(remoteJid) ? remoteJid : explicit && isChatAlias(explicit) ? explicit.lid : undefined;
        const pn = lid ? aliases.get(lid) : undefined;
        if (lid && pn && !reconciled.has(lid)) {
          await reconcileAlias(instance, { lid, pn });
          reconciled.add(lid);
        }
        const message = pn && remoteJid !== pn ? {
          ...original, key: { ...original.key, remoteJid: pn, remoteJidAlt: remoteJid, addressingMode: 'pn' },
        } : original;
        const storedId = await store(instance, message);
        if (!storedId) continue;
        if (withMedia && message.media) {
          try {
            await persistMedia(storedId, instance, message);
          } catch (err) {
            // The message itself is safe; only its preview stays a type label.
            logger.error({ err, keyId: message.key.id, instance: instance.name }, 'failed to persist media');
          }
        }
        await projectChat(instance, message);
        if (publish) {
          // Stories use the broadcast JID, not a chat JID. Keep the row for history but
          // make delivery an explicit opt-in extension instead of leaking it as a chat upsert.
          const event = message.key.remoteJid === 'status@broadcast' ? 'STATUS_UPDATE' : 'MESSAGES_UPSERT';
          await outbox.enqueue(toMessageEvent(instance, message, event));
        }
      } catch (err) {
        logger.error({ err, keyId: original.key.id, instance: instance.name }, 'failed to ingest message');
      }
    }
  }

  /** Names group chats. A sync before the first message is retained in `chatNames`. */
  async function nameGroups(instance: Instance, groups: GroupSummary[]): Promise<void> {
    for (const group of groups) {
      chatNames.set(nameKey(instance, group.id), group.subject);
      try {
        await db.chat.updateMany({
          where: { instanceId: instance.id, remoteJid: group.id },
          data: { name: group.subject },
        });
      } catch (err) {
        logger.error({ err, group: group.id, instance: instance.name }, 'failed to name a group chat');
      }
    }
  }

  /** Names existing direct chats without creating an address-book-shaped chat list. */
  async function nameContacts(instance: Instance, contacts: ContactSummary[]): Promise<void> {
    const aliases = await loadChatAliases(db, instance.id);
    for (const original of contacts) {
      const pn = aliases.get(original.id);
      if (pn) await reconcileAlias(instance, { lid: original.id, pn });
      const contact = pn ? { ...original, id: pn } : original;
      chatNames.set(nameKey(instance, contact.id), contact.name);
      try {
        await db.chat.updateMany({
          where: { instanceId: instance.id, remoteJid: contact.id },
          data: { name: contact.name },
        });
      } catch (err) {
        logger.error({ err, contact: contact.id, instance: instance.name }, 'failed to name a contact chat');
      }
    }
  }

  async function importHistory(instance: Instance, contacts: ContactSummary[], messages: InboundMessage[]): Promise<void> {
    for (let start = 0; start < contacts.length; start += HISTORY_BATCH) {
      await serialize(instance, () => nameContacts(instance, contacts.slice(start, start + HISTORY_BATCH)));
    }
    // Enqueue only the next batch, allowing live events to run between batches.
    for (let start = 0; start < messages.length; start += HISTORY_BATCH) {
      await serialize(instance, () => ingest(instance, messages.slice(start, start + HISTORY_BATCH), false, false));
    }
  }

  function handle(event: InstanceEvent): Promise<void> {
    if (event.type === 'chat-alias') return serialize(event.instance, () => reconcileAlias(event.instance, event.alias));
    if (event.type === 'contacts') return serialize(event.instance, () => nameContacts(event.instance, event.contacts));
    if (event.type === 'groups') return serialize(event.instance, () => nameGroups(event.instance, event.groups));
    if (event.type === 'message-edited') return serialize(event.instance, () => editMessage(event.instance, event.message));
    if (event.type === 'message-updated') return serialize(event.instance, () => updateMessage(event.instance, event.update));
    if (event.type === 'message-deleted') return serialize(event.instance, () => deleteMessage(event.instance, event.key));
    // A receipt can arrive before Baileys echoes the outbound upsert. Store the send now
    // so the receipt has a row to advance; the echo is then safely idempotent.
    if (event.type === 'sent') return serialize(event.instance, () => ingest(event.instance, [event.message], false));
    if (event.type === 'messages') return serialize(event.instance, () => ingest(event.instance, event.messages));
    if (event.type === 'history') {
      return importHistory(event.instance, event.contacts, event.messages);
    }
    return Promise.resolve();
  }

  /** Subscribes to instance events; returns the unsubscribe handle. */
  function watch(instanceService: InstanceService): () => void {
    return instanceService.subscribe(handle);
  }

  return { editMessage, ingest, nameContacts, nameGroups, handle, watch };
}

export type MessageService = ReturnType<typeof createMessageService>;
