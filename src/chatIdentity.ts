import { isDeepStrictEqual } from 'node:util';
import type { Db } from './db';

export type ChatAlias = { lid: string; pn: string };
export type AliasRepair = ChatAlias & {
  messages: number;
  duplicates: number;
  action: 'merge' | 'rename' | 'unresolved' | 'blocked';
  reason?: string;
};

/** Accept only explicit, device-independent identities; LID digits are not phone numbers. */
export function isChatAlias(alias: ChatAlias): boolean {
  return /^\d+@lid$/.test(alias.lid) && /^\d+@s\.whatsapp\.net$/.test(alias.pn);
}

/** Baileys persists phone -> LID and LID_reverse -> phone in its Signal key store. */
export async function loadChatAliases(db: Db, instanceId: string): Promise<Map<string, string>> {
  const auth = await db.baileysAuthState.findUnique({ where: { instanceId }, select: { keys: true } });
  const keys = auth?.keys as Record<string, unknown> | undefined;
  const stored = keys?.['lid-mapping'] as Record<string, unknown> | undefined;
  const aliases = new Map<string, string>();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return aliases;
  for (const [key, value] of Object.entries(stored)) {
    if (!key.endsWith('_reverse') || typeof value !== 'string') continue;
    const lidUser = key.slice(0, -8);
    const alias = { lid: `${lidUser}@lid`, pn: `${value}@s.whatsapp.net` };
    // Stale reverse entries can survive a changed mapping. Never merge those identities.
    if (isChatAlias(alias) && stored[value] === lidUser) aliases.set(alias.lid, alias.pn);
  }
  return aliases;
}

const RECEIPTS = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];

/** Preview and apply use the same conflict checks, inside a transaction for each identity. */
export async function reconcileChatAlias(db: Db, instanceId: string, alias: ChatAlias, apply = false): Promise<AliasRepair> {
  if (!isChatAlias(alias)) throw new Error('Invalid LID/phone mapping');
  return db.$transaction(async (tx) => {
    const [source, sourceMessages] = await Promise.all([
      tx.chat.findUnique({ where: { instanceId_remoteJid: { instanceId, remoteJid: alias.lid } } }),
      tx.message.findMany({ where: { instanceId, remoteJid: alias.lid }, include: { media: true } }),
    ]);
    if (!source && !sourceMessages.length) return { ...alias, messages: 0, duplicates: 0, action: 'rename' };
    const [target, targetMessages] = await Promise.all([
      tx.chat.findUnique({ where: { instanceId_remoteJid: { instanceId, remoteJid: alias.pn } } }),
      tx.message.findMany({ where: { instanceId, remoteJid: alias.pn }, include: { media: true } }),
    ]);
    const key = (message: { fromMe: boolean; keyId: string }) => `${message.fromMe}:${message.keyId}`;
    const targets = new Map(targetMessages.map((message) => [key(message), message]));
    let duplicates = 0;
    let reason: string | undefined;
    for (const message of sourceMessages) {
      const duplicate = targets.get(key(message));
      if (!duplicate) continue;
      duplicates++;
      if (!isDeepStrictEqual(message.content, duplicate.content) || !isDeepStrictEqual(message.contextInfo, duplicate.contextInfo)) {
        reason = 'Duplicate message keys have different content or metadata';
      }
      if (message.status !== duplicate.status &&
          (!RECEIPTS.includes(message.status ?? '') || !RECEIPTS.includes(duplicate.status ?? ''))) {
        reason = 'Duplicate message keys have incompatible edit/delete states';
      }
      if (message.media && duplicate.media &&
          (message.media.path !== duplicate.media.path || message.media.mimetype !== duplicate.media.mimetype || message.media.size !== duplicate.media.size)) {
        reason = 'Duplicate message keys have different media';
      }
    }
    const plan: AliasRepair = {
      ...alias, messages: sourceMessages.length, duplicates,
      action: reason ? 'blocked' : target ? 'merge' : 'rename',
      ...(reason ? { reason } : {}),
    };
    if (!apply || reason || (!source && !sourceMessages.length)) return plan;

    for (const message of sourceMessages) {
      const duplicate = targets.get(key(message));
      if (!duplicate) continue;
      if (message.media && !duplicate.media) {
        await tx.media.update({ where: { id: message.media.id }, data: { messageId: duplicate.id } });
      }
      if (RECEIPTS.indexOf(message.status ?? '') > RECEIPTS.indexOf(duplicate.status ?? '')) {
        await tx.message.update({ where: { id: duplicate.id }, data: { status: message.status } });
      }
      await tx.message.delete({ where: { id: message.id } });
    }
    await tx.message.updateMany({ where: { instanceId, remoteJid: alias.lid }, data: { remoteJid: alias.pn } });
    if (source) {
      // The phone-address contact name is preferred; a LID name fills only an empty one.
      if (target) {
        const sourceIsNewer = source.lastMessageAt && (!target.lastMessageAt || source.lastMessageAt > target.lastMessageAt);
        await tx.chat.update({ where: { id: target.id }, data: {
          name: target.name ?? source.name,
          unreadMessages: Math.max(target.unreadMessages, source.unreadMessages),
          ...(sourceIsNewer ? { lastMessageAt: source.lastMessageAt, lastMessagePreview: source.lastMessagePreview } : {}),
        } });
        await tx.chat.delete({ where: { id: source.id } });
      } else {
        await tx.chat.update({ where: { id: source.id }, data: { remoteJid: alias.pn } });
      }
    }
    return plan;
  });
}

/** Read-only by default. Unknown or conflicting identities are reported, never guessed. */
export async function repairChatAliases(db: Db, instanceId: string, apply = false): Promise<AliasRepair[]> {
  const aliases = await loadChatAliases(db, instanceId);
  const [chats, messages] = await Promise.all([
    db.chat.findMany({ where: { instanceId, remoteJid: { endsWith: '@lid' } }, select: { remoteJid: true } }),
    db.message.findMany({ where: { instanceId, remoteJid: { endsWith: '@lid' } }, select: { remoteJid: true } }),
  ]);
  const lids = new Set([...chats, ...messages].map((row) => row.remoteJid));
  const plans: AliasRepair[] = [];
  for (const lid of lids) {
    const pn = aliases.get(lid);
    plans.push(pn ? await reconcileChatAlias(db, instanceId, { lid, pn }, apply)
      : { lid, pn: '', messages: messages.filter((message) => message.remoteJid === lid).length, duplicates: 0, action: 'unresolved', reason: 'No reciprocal Baileys mapping' });
  }
  return plans;
}
