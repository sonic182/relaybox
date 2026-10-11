import type { JsonObject } from '@zenstackhq/orm';
import type { Logger } from 'pino';
import type { Db } from './db';
import { DbNull } from '@zenstackhq/orm';
/** Completed idempotency responses are retained long enough for ordinary client retries. */
export const SEND_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Raised while an earlier request holding the same key has not finished sending. */
export class SendInProgressError extends Error {
  constructor(key: string) {
    super(`A send with idempotency key "${key}" is already in progress`);
    this.name = 'SendInProgressError';
  }
}

export type SendService = {
  /**
     * Runs `send` at most once per key and replays its stored response afterwards, so a
     * client that retries a request whose answer it never saw does not send twice.
     */
  once<T>(instanceId: string, key: string | undefined, send: () => Promise<T>): Promise<T>;
  /** Deletes replayable responses older than the retention window, never in-flight claims. */
  pruneCompleted(before?: Date): Promise<number>;
};

export function createSendService({ db, logger }: { db: Db; logger: Logger }): SendService {
  return {
    async once<T>(instanceId: string, key: string | undefined, send: () => Promise<T>): Promise<T> {
      // Without a key the caller has not asked for the guarantee, so do not invent it.
      if (!key) return send();

      const where = { instanceId_idempotencyKey: { instanceId, idempotencyKey: key } };

      try {
        // Claim the key before anything leaves, so two concurrent retries race here
        // against the unique constraint rather than at WhatsApp.
        await db.sendRequest.create({ data: { instanceId, idempotencyKey: key } });
      } catch (err) {
        // Only a taken key means someone got here first. Any other failure — an
        // unknown instance, a dead connection — must surface as itself rather than
        // as a misleading "already in progress".
        const existing = await db.sendRequest.findUnique({ where });
        if (!existing) throw err;
        if (existing.response) return existing.response as T;
        throw new SendInProgressError(key);
      }

      let message: T;
      try {
        message = await send();
      } catch (err) {
        // Nothing left, so release the key rather than blocking every retry. Only
        // the send itself is covered here: past this point the message is gone.
        await db.sendRequest.deleteMany({ where: { instanceId, idempotencyKey: key } });
        throw err;
      }

      try {
        await db.sendRequest.update({ where, data: { response: message as unknown as JsonObject } });
      } catch (err) {
        // The message is already sent, so the claim must stand even though we
        // cannot record what to replay. A retry gets 409 rather than a second
        // WhatsApp message, which is the safe way to be wrong.
        //
        // ponytail: that key then stays unresolvable. Give SendRequest a terminal
        // 'unknown' state, or an expiry, if this is ever seen in practice.
        logger.error({ err }, 'sent but response not recorded');
      }

      return message;
    },

    async pruneCompleted(before = new Date(Date.now() - SEND_REQUEST_RETENTION_MS)) {
      const deleted = await db.sendRequest.deleteMany({
        where: { response: { not: DbNull }, updatedAt: { lt: before } },
      });
      return deleted.count;
    },
  };
}
