import type { Db } from './db';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_DIR, MEDIA_TYPES, isValidName, type InboundMessage, type InstanceService } from './instances';
import { mediaExtension } from './messages';

/** A chat as the list shows it; the projection `src/messages.ts` maintains. */
export type ChatSummary = {
  remoteJid: string;
  name: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
};

/**
 * A message as the timeline shows it. Deliberately not the stored row: `content` holds the
 * raw Baileys payload, which must never reach the browser. Only plain text is lifted out of
 * it, and anything else is described by its type.
 */
export type ChatMessage = {
  /** The WhatsApp message key, which is what identifies a message across the echo. */
  keyId: string;
  fromMe: boolean;
  pushName: string | null;
  messageType: string;
  messageTimestamp: number;
  status: string | null;
  /** Null for media and anything else with no plain text. */
  text: string | null;
  /** Set when a downloaded file backs this message; decides what the bubble renders. */
  mediaType?: 'image' | 'video' | 'audio' | 'file';
};

export type MessagePage = {
  /** Oldest first, the order a conversation reads in. */
  messages: ChatMessage[];
  /** Pass back as `before` for the previous page; null once the chat starts. */
  cursor: string | null;
};

export type ChatPage = {
  chats: ChatSummary[];
  /** Pass back as `before` to continue with less recently active chats. */
  cursor: string | null;
};

export type ChatService = {
  listChats(instanceName: string, options?: { before?: string; limit?: number; search?: string }): Promise<ChatPage>;
  listMessages(
    instanceName: string,
    remoteJid: string,
    options?: { before?: string; limit?: number },
  ): Promise<MessagePage>;
  findMessage(instanceName: string, keyId: string): Promise<{
    key: InboundMessage['key'];
    pushName: string | null;
    message: Record<string, unknown>;
    contextInfo: unknown;
    messageType: string;
    messageTimestamp: number;
    status: string | null;
    media: { path: string; mimetype: string } | null;
  } | null>;
  /** Cached media, downloading an imported payload on demand when possible. */
  getMedia(instanceName: string, keyId: string): Promise<{ path: string; mimetype: string; messageType: string } | null>;
};

type StoredMessage = {
  /** The row id, which only the cursor needs; the timeline identifies by `keyId`. */
  id: string;
  keyId: string;
  fromMe: boolean;
  pushName: string | null;
  messageType: string;
  messageTimestamp: number;
  status: string | null;
  content: unknown;
  /** Present only when the download succeeded and the file is on disk. */
  media: { path: string; mimetype: string } | null;
};

/** WhatsApp time plus the row id, because one second can hold several messages. */
function toCursor(message: { messageTimestamp: number; id: string }): string {
  return `${message.messageTimestamp}:${message.id}`;
}

function parseCursor(cursor: string | undefined): { messageTimestamp: number; id: string } | undefined {
  if (!cursor) return undefined;

  const separator = cursor.indexOf(':');
  const messageTimestamp = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);

  return separator > 0 && Number.isFinite(messageTimestamp) && id ? { messageTimestamp, id } : undefined;
}

type ChatCursor = { lastMessageAt: string | null; remoteJid: string };

function encodeChatCursor(chat: ChatCursor): string {
  return Buffer.from(JSON.stringify(chat)).toString('base64url');
}

function decodeChatCursor(cursor: string | undefined): ChatCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (
      typeof parsed === 'object' && parsed !== null &&
      'remoteJid' in parsed && typeof parsed.remoteJid === 'string' &&
      'lastMessageAt' in parsed && (parsed.lastMessageAt === null ||
        (typeof parsed.lastMessageAt === 'string' && Number.isFinite(Date.parse(parsed.lastMessageAt))))
    ) {
      return parsed as ChatCursor;
    }
  } catch {
    // An invalid cursor starts from the first page, like listMessages.
  }
  return undefined;
}

/**
 * A message we just sent, in the shape the timeline renders. The row for it arrives later,
 * through the `messages.upsert` echo, so a reply would otherwise vanish until a reload.
 */
export function toSentChatMessage(message: InboundMessage): ChatMessage {
  const text = message.message.conversation;

  return {
    keyId: message.key.id,
    fromMe: true,
    pushName: message.pushName ?? null,
    messageType: message.messageType,
    messageTimestamp: message.messageTimestamp,
    status: message.status ?? null,
    text: typeof text === 'string' ? text : null,
  };
}

function toChatMessage({ keyId, fromMe, pushName, messageType, messageTimestamp, status, content, media }: StoredMessage): ChatMessage {
  const text = (content as { conversation?: unknown } | null)?.conversation;
  const kind = media ? mediaKind(messageType) : undefined;

  return {
    keyId,
    fromMe,
    pushName,
    messageType,
    messageTimestamp,
    status,
    text: status === 'DELETED' ? null : typeof text === 'string' ? text : null,
    ...(kind && status !== 'DELETED' ? { mediaType: kind } : {}),
  };
}

/** What the timeline can render for a content type; undefined when there is nothing to show. */
function mediaKind(messageType: string): ChatMessage['mediaType'] {
  switch (messageType) {
    case 'imageMessage':
    case 'stickerMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'audioMessage':
      return 'audio';
    case 'documentMessage':
      return 'file';
    default:
      return undefined;
  }
}

/** Queries persisted chats and lazily caches media through the injected downloader. */
export function createChatService({ db, downloadMedia }: {
  db: Db;
  downloadMedia?: InstanceService['downloadMessageMedia'];
}): ChatService {
  const downloads = new Map<string, Promise<Awaited<ReturnType<ChatService['getMedia']>>>>();
  async function instanceId(instanceName: string): Promise<string | undefined> {
    const instance = await db.instanceRecord.findUnique({ where: { name: instanceName }, select: { id: true } });
    return instance?.id;
  }

  return {
    async listChats(instanceName, { before, limit = 50, search } = {}) {
      const id = await instanceId(instanceName);
      if (!id) return { chats: [], cursor: null };

      const cursor = decodeChatCursor(before);
      const term = search?.trim();
      const rows = await db.chat.findMany({
        where: {
          instanceId: id,
          AND: [
            ...(term ? [{
              OR: [
                { remoteJid: { contains: term, mode: 'insensitive' as const } },
                { name: { contains: term, mode: 'insensitive' as const } },
              ],
            }] : []),
            ...(cursor ? [{
              OR: cursor.lastMessageAt === null
                ? [{ lastMessageAt: null, remoteJid: { gt: cursor.remoteJid } }]
                : [
                  { lastMessageAt: { lt: new Date(cursor.lastMessageAt) } },
                  { lastMessageAt: new Date(cursor.lastMessageAt), remoteJid: { gt: cursor.remoteJid } },
                  { lastMessageAt: null },
                ],
            }] : []),
          ],
        },
        select: { remoteJid: true, name: true, lastMessageAt: true, lastMessagePreview: true },
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { remoteJid: 'asc' }],
        take: limit + 1,
      });

      const chats = rows.slice(0, limit);
      const last = chats[chats.length - 1];
      return {
        chats,
        cursor: rows.length > limit && last
          ? encodeChatCursor({ lastMessageAt: last.lastMessageAt?.toISOString() ?? null, remoteJid: last.remoteJid })
          : null,
      };
    },

    async listMessages(instanceName, remoteJid, { before, limit = 30 } = {}) {
      const id = await instanceId(instanceName);
      if (!id) return { messages: [], cursor: null };

      const cursor = parseCursor(before);
      const rows = await db.message.findMany({
        where: {
          instanceId: id,
          remoteJid,
          ...(cursor
            ? {
              OR: [
                { messageTimestamp: { lt: cursor.messageTimestamp } },
                { messageTimestamp: cursor.messageTimestamp, id: { lt: cursor.id } },
              ],
            }
            : {}),
        },
        select: {
          id: true,
          keyId: true,
          fromMe: true,
          pushName: true,
          messageType: true,
          messageTimestamp: true,
          status: true,
          content: true,
          media: { select: { path: true, mimetype: true } },
        },
        orderBy: [{ messageTimestamp: 'desc' }, { id: 'desc' }],
        // One extra row answers "is there another page" without a second count.
        take: limit + 1,
      });

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];

      return {
        messages: page.map(toChatMessage).reverse(),
        cursor: rows.length > limit && last ? toCursor(last) : null,
      };
    },

    async findMessage(instanceName, keyId) {
      const id = await instanceId(instanceName);
      if (!id) return null;

      const row = await db.message.findFirst({
        where: {
          instanceId: id,
          keyId,
          OR: [{ status: null }, { status: { not: 'DELETED' } }],
        },
        select: {
          remoteJid: true,
          fromMe: true,
          keyId: true,
          participant: true,
          pushName: true,
          content: true,
          contextInfo: true,
          messageType: true,
          messageTimestamp: true,
          status: true,
          media: { select: { path: true, mimetype: true } },
        },
      });
      if (!row) return null;

      return {
        key: {
          remoteJid: row.remoteJid,
          fromMe: row.fromMe,
          id: row.keyId,
          ...(row.participant ? { participant: row.participant } : {}),
        },
        pushName: row.pushName,
        message: row.content as Record<string, unknown>,
        contextInfo: row.contextInfo,
        messageType: row.messageType,
        messageTimestamp: row.messageTimestamp,
        status: row.status,
        media: row.media,
      };
    },

    async getMedia(instanceName, keyId) {
      if (!isValidName(instanceName)) return null;
      const id = await instanceId(instanceName);
      if (!id) return null;

      const row = await db.message.findFirst({
        where: {
          instanceId: id,
          keyId,
          OR: [{ status: null }, { status: { not: 'DELETED' } }],
        },
        select: { id: true, remoteJid: true, fromMe: true, participant: true, content: true, messageType: true,
          media: { select: { path: true, mimetype: true } } },
      });
      if (!row) return null;
      if (row.media) return { ...row.media, messageType: row.messageType };
      if (!downloadMedia || !MEDIA_TYPES.has(row.messageType)) return null;
      const existing = downloads.get(row.id);
      if (existing) return existing;
      const download = (async () => {
        const media = await downloadMedia(instanceName, {
          key: { id: keyId, remoteJid: row.remoteJid, fromMe: row.fromMe, ...(row.participant ? { participant: row.participant } : {}) },
          message: row.content as Record<string, unknown>, messageType: row.messageType,
        });
        if (!media) return null;
        // A revoke can arrive during network I/O. Never cache newly deleted media.
        const current = await db.message.findUnique({ where: { id: row.id }, select: { status: true } });
        if (!current || current.status === 'DELETED') return null;
        const path = `${randomUUID()}${mediaExtension(media.mimetype)}`;
        const directory = join(MEDIA_DIR, instanceName);
        await mkdir(directory, { recursive: true });
        const file = join(directory, path);
        await writeFile(file, media.buffer, { flag: 'wx' });
        try {
          const cached = await db.media.upsert({ where: { messageId: row.id },
            create: { messageId: row.id, path, mimetype: media.mimetype, size: media.buffer.length }, update: {},
          });
          if (cached.path !== path) await unlink(file);
          return { path: cached.path, mimetype: cached.mimetype, messageType: row.messageType };
        } catch (err) {
          await unlink(file).catch(() => {});
          throw err;
        }
      })();
      downloads.set(row.id, download);
      try {
        return await download;
      } finally {
        if (downloads.get(row.id) === download) downloads.delete(row.id);
      }
    },
  };
}
