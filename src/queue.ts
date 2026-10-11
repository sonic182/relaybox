import { DbNull, type JsonObject } from '@zenstackhq/orm';
import type { Logger } from 'pino';
import type { Db } from './db';

export type DeliveryJob = {
  id: string;
  instanceId: string;
  event: string;
  url: string;
  payload: unknown;
  /** Attempts already made, so a handler can log or give up on its own terms. */
  attempts: number;
};

export type NewDeliveryJob = Omit<DeliveryJob, 'attempts'> & {
  /** Rejecting a repeat is the queue's job, not the caller's. */
  dedupeKey: string;
  availableAt: Date;
};

/** What one attempt reports back. The queue decides what to do with a failure. */
export type DeliveryOutcome =
    | { status: 'delivered'; responseStatus: number }
    | { status: 'failed'; responseStatus?: number; error: string; retryable: boolean };

export type DeliveryHandler = (job: DeliveryJob) => Promise<DeliveryOutcome>;

/**
 * The seam between "what to deliver" and "how work is scheduled". The database-backed
 * implementation below needs no broker; a Redis/BullMQ implementation would satisfy the
 * same two methods, with retry timing owned by the broker instead of by `nextAttemptAt`.
 */
export type DeliveryQueue = {
  /** False when the job was already queued. */
  enqueue(job: NewDeliveryJob): Promise<boolean>;
  /** Starts consuming; returns a stop function that resolves once an in-flight drain settles. */
  consume(handler: DeliveryHandler): () => Promise<void>;
};

/** Exponential backoff with full jitter, so a fleet of retries does not synchronize. */
export function backoffMs(attempts: number, baseDelayMs: number, maxDelayMs: number, random = Math.random): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempts);
  return Math.round(baseDelayMs + random() * (ceiling - baseDelayMs));
}

export type DatabaseQueueOptions = {
  db: Db;
  logger: Logger;
  now?: () => Date;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  batchSize?: number;
  /** How many due jobs one drain delivers at once. */
  concurrency?: number;
  pollIntervalMs?: number;
  random?: () => number;
};

/** A `DeliveryQueue` whose queue is the `WebhookDelivery` table. */
export function createDatabaseQueue({
  db,
  logger,
  now = () => new Date(),
  maxAttempts = 6,
  baseDelayMs = 1_000,
  maxDelayMs = 5 * 60_000,
  batchSize = 20,
  concurrency = 4,
  pollIntervalMs = 2_000,
  random = Math.random,
}: DatabaseQueueOptions) {
  let wake: (() => void) | undefined;

  async function enqueue(job: NewDeliveryJob): Promise<boolean> {
    try {
      await db.webhookDelivery.create({
        data: {
          id: job.id,
          instanceId: job.instanceId,
          event: job.event,
          url: job.url,
          payload: job.payload as JsonObject,
          dedupeKey: job.dedupeKey,
          nextAttemptAt: job.availableAt,
        },
      });
      // A queued row is already due; nudge the consumer instead of waiting out the poll.
      wake?.();
      return true;
    } catch (err) {
      // A duplicate dedupeKey means this occurrence is already queued.
      logger.debug({ err, dedupeKey: job.dedupeKey }, 'delivery not enqueued');
      return false;
    }
  }

  async function settle(job: DeliveryJob, outcome: DeliveryOutcome): Promise<void> {
    const attempts = job.attempts + 1;

    if (outcome.status === 'delivered') {
      await db.webhookDelivery.update({
        where: { id: job.id },
        data: {
          status: 'delivered',
          attempts,
          deliveredAt: now(),
          responseStatus: outcome.responseStatus,
          nextAttemptAt: null,
          lastError: null,
        },
      });
      return;
    }

    const retry = outcome.retryable && attempts < maxAttempts;
    await db.webhookDelivery.update({
      where: { id: job.id },
      data: {
        status: retry ? 'pending' : 'failed',
        attempts,
        responseStatus: outcome.responseStatus ?? null,
        lastError: outcome.error,
        nextAttemptAt: retry
          ? new Date(now().getTime() + backoffMs(attempts, baseDelayMs, maxDelayMs, random))
          : null,
      },
    });
  }

  async function attempt(job: DeliveryJob, handler: DeliveryHandler): Promise<void> {
    let outcome: DeliveryOutcome;
    try {
      outcome = await handler(job);
    } catch (err) {
      outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err), retryable: true };
    }

    await settle(job, outcome).catch((err: unknown) =>
      logger.error({ err, deliveryId: job.id }, 'failed to record delivery outcome'),
    );
  }

  /** Runs one pass over the due jobs; returns how many were attempted. */
  async function drain(handler: DeliveryHandler): Promise<number> {
    const due = await db.webhookDelivery.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: now() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: batchSize,
    });

    // Bound concurrency so one slow consumer cannot serialize the whole batch. Each
    // settle writes its own row, so overlapping attempts stay single-process safe;
    // the no-claim ceiling still applies across processes.
    for (let start = 0; start < due.length; start += concurrency) {
      await Promise.all(due.slice(start, start + concurrency).map((job) => attempt(job, handler)));
    }

    return due.length;
  }

  /**
     * Restart recovery needs no extra work: an interrupted job is still `pending` with
     * `nextAttemptAt` in the past, so the next tick takes it.
     *
     * ponytail: no row claim, so this is single-process only — two consumers would take
     * the same due jobs and deliver twice. Add a lease (an `inflight` status with a holder
     * id, or `SELECT ... FOR UPDATE SKIP LOCKED` on Postgres) before running more than one
     * process; swap in a broker-backed DeliveryQueue only if the table stops keeping up.
     */
  function consume(handler: DeliveryHandler): () => Promise<void> {
    let draining = false;
    let rerun = false;
    let stopped = false;
    let drainWaiter: (() => void) | undefined;

    const drainNow = () => {
      if (stopped) return;
      if (draining) {
        rerun = true;
        return;
      }
      draining = true;
      void drain(handler)
        .catch((err: unknown) => logger.error({ err }, 'delivery queue tick failed'))
        .finally(() => {
          draining = false;
          drainWaiter?.();
          drainWaiter = undefined;
          // A job enqueued mid-drain missed this pass; take it without waiting out the poll.
          if (!stopped && rerun) {
            rerun = false;
            drainNow();
          }
        });
    };

    wake = drainNow;
    const timer = setInterval(drainNow, pollIntervalMs);
    timer.unref();

    // Resolves once an in-flight drain settles, so shutdown can record the last
    // delivery instead of re-sending it as a duplicate after restart.
    return () => {
      stopped = true;
      clearInterval(timer);
      if (wake === drainNow) wake = undefined;
      if (!draining) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainWaiter = resolve;
      });
    };
  }

  async function compactFinished(before: Date): Promise<number> {
    const compacted = await db.webhookDelivery.updateMany({
      where: { status: { in: ['delivered', 'failed'] }, createdAt: { lt: before }, payload: { not: DbNull } },
      data: { payload: DbNull },
    });
    return compacted.count;
  }

  return { enqueue, consume, drain, compactFinished };
}

export type DatabaseQueue = ReturnType<typeof createDatabaseQueue>;
