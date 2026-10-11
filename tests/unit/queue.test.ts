import { describe, expect, it, vi } from 'vitest';
import { backoffMs, createDatabaseQueue } from '../../src/queue';
import { createTestDb, silentLogger } from '../helpers';

async function seedInstance(db: ReturnType<typeof createTestDb>) {
  return db.instanceRecord.create({ data: { name: 'acme' } });
}

function job(instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    instanceId,
    event: 'CONNECTION_UPDATE',
    url: 'https://consumer.example/hook',
    payload: { event: 'connection.update' },
    dedupeKey: 'CONNECTION_UPDATE:job-1',
    availableAt: new Date('2026-08-30T12:00:00.000Z'),
    ...overrides,
  };
}

const fixedNow = () => new Date('2026-08-30T12:00:00.000Z');

async function setupQueue(options: Omit<Parameters<typeof createDatabaseQueue>[0], 'db' | 'logger'> = {}) {
  const db = createTestDb();
  const instance = await seedInstance(db);
  return { db, instance, queue: createDatabaseQueue({ db, logger: silentLogger(), ...options }) };
}

function blockingHandler() {
  let release!: () => void;
  const handler = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { status: 'delivered' as const, responseStatus: 200 };
  });
  return { handler, release: () => release() };
}

describe('backoffMs', () => {
  it('grows with attempts and stays within the ceiling', () => {
    expect(backoffMs(0, 1000, 60_000, () => 0)).toBe(1000);
    expect(backoffMs(1, 1000, 60_000, () => 1)).toBe(2000);
    expect(backoffMs(10, 1000, 60_000, () => 1)).toBe(60_000);
  });
});

describe('createDatabaseQueue', () => {
  it('rejects a repeated dedupe key', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const queue = createDatabaseQueue({ db, logger: silentLogger() });

    expect(await queue.enqueue(job(instance.id))).toBe(true);
    expect(await queue.enqueue(job(instance.id, { id: 'job-2' }))).toBe(false);
    expect(await db.webhookDelivery.count()).toBe(1);
  });

  it('drains only jobs whose nextAttemptAt is due', async () => {
    const { instance, queue } = await setupQueue({ now: fixedNow });

    await queue.enqueue(job(instance.id, { availableAt: new Date('2026-08-30T11:59:00.000Z') }));
    await queue.enqueue(job(instance.id, { id: 'job-2', dedupeKey: 'k2', availableAt: new Date('2026-08-30T12:30:00.000Z') }));

    const seen: string[] = [];
    const count = await queue.drain(async (due) => {
      seen.push(due.id);
      return { status: 'delivered', responseStatus: 200 };
    });

    expect(count).toBe(1);
    expect(seen).toEqual(['job-1']);
  });

  it('marks a delivered job with its response status and clears the retry schedule', async () => {
    const { db, instance, queue } = await setupQueue({ now: fixedNow });
    await queue.enqueue(job(instance.id));

    await queue.drain(async () => ({ status: 'delivered', responseStatus: 200 }));

    const [row] = await db.webhookDelivery.findMany();
    expect(row).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 200, nextAttemptAt: null });
    expect(row.deliveredAt).toEqual(fixedNow());
  });

  it('reschedules a retryable failure with backoff and gives up after maxAttempts', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const now = () => new Date('2026-08-30T12:00:00.000Z');
    const queue = createDatabaseQueue({ db, logger: silentLogger(), now, maxAttempts: 2, baseDelayMs: 1000, random: () => 0 });
    await queue.enqueue(job(instance.id));

    await queue.drain(async () => ({ status: 'failed', error: 'timeout', retryable: true }));
    let [row] = await db.webhookDelivery.findMany();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastError: 'timeout' });
    expect(row.nextAttemptAt).toEqual(new Date(now().getTime() + 1000));

    // Second failure exhausts maxAttempts: 2.
    await db.webhookDelivery.update({ where: { id: row.id }, data: { nextAttemptAt: now() } });
    await queue.drain(async () => ({ status: 'failed', error: 'timeout', retryable: true }));
    [row] = await db.webhookDelivery.findMany();
    expect(row).toMatchObject({ status: 'failed', attempts: 2, nextAttemptAt: null });
  });

  it('fails a non-retryable outcome immediately, without scheduling a retry', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const now = () => new Date('2026-08-30T12:00:00.000Z');
    const queue = createDatabaseQueue({ db, logger: silentLogger(), now, maxAttempts: 6 });
    await queue.enqueue(job(instance.id));

    await queue.drain(async () => ({ status: 'failed', responseStatus: 400, error: 'bad request', retryable: false }));

    const [row] = await db.webhookDelivery.findMany();
    expect(row).toMatchObject({ status: 'failed', attempts: 1, responseStatus: 400, nextAttemptAt: null });
  });

  it('treats a handler that throws as a retryable failure', async () => {
    const { db, instance, queue } = await setupQueue({ now: fixedNow });
    await queue.enqueue(job(instance.id));

    await queue.drain(async () => {
      throw new Error('boom');
    });

    const [row] = await db.webhookDelivery.findMany();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastError: 'boom' });
  });

  it('does not overlap interval drains while a delivery is still running', async () => {
    const { db, instance, queue } = await setupQueue({ now: fixedNow, pollIntervalMs: 5 });
    await queue.enqueue(job(instance.id));

    const { handler, release } = blockingHandler();
    const stop = queue.consume(handler);

    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(handler).toHaveBeenCalledTimes(1);

      release();
      await vi.waitFor(async () => {
        const row = await db.webhookDelivery.findUnique({ where: { id: 'job-1' } });
        expect(row?.status).toBe('delivered');
      });
    } finally {
      stop();
    }
  });

  it('delivers due jobs concurrently so one slow consumer cannot serialize the batch', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const now = () => new Date('2026-08-30T12:00:00.000Z');
    const queue = createDatabaseQueue({ db, logger: silentLogger(), now, concurrency: 2 });
    await queue.enqueue(job(instance.id));
    await queue.enqueue(job(instance.id, { id: 'job-2', dedupeKey: 'k2' }));

    let started = 0;
    const releases: (() => void)[] = [];
    const bothStarted = vi.fn();
    const handler = async () => {
      started += 1;
      if (started === 2) bothStarted();
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 'delivered' as const, responseStatus: 200 };
    };

    const draining = queue.drain(handler);
    await vi.waitFor(() => expect(bothStarted).toHaveBeenCalled());
    expect(started).toBe(2);
    releases.forEach((release) => release());
    await draining;
  });

  it('delivers immediately on enqueue instead of waiting out the poll interval', async () => {
    const { instance, queue } = await setupQueue({ now: fixedNow, pollIntervalMs: 60_000 });
    const handler = vi.fn(async () => ({ status: 'delivered' as const, responseStatus: 200 }));
    const stop = queue.consume(handler);

    try {
      await queue.enqueue(job(instance.id));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    } finally {
      stop();
    }
  });

  it('stop() resolves only after an in-flight drain settles', async () => {
    const { db, instance, queue } = await setupQueue({ now: fixedNow, pollIntervalMs: 60_000 });
    const { handler, release } = blockingHandler();
    const stop = queue.consume(handler);

    await queue.enqueue(job(instance.id));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const stopped = stop();
    let resolved = false;
    void stopped.then(() => {
      resolved = true;
    });
    // The handler is still in flight; stop must not resolve yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);

    release();
    await stopped;
    // Settling recorded the delivery, so a restart would not re-send it.
    const row = await db.webhookDelivery.findUnique({ where: { id: 'job-1' } });
    expect(row?.status).toBe('delivered');
  });

  it('restart recovery needs no extra step: an interrupted job is still pending and due', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const now = () => new Date('2026-08-30T12:00:00.000Z');
    const first = createDatabaseQueue({ db, logger: silentLogger(), now });
    await first.enqueue(job(instance.id));

    // Simulate a crash mid-delivery: nothing marks the row inflight, so it is
    // exactly where a fresh process would find it.
    const restarted = createDatabaseQueue({ db, logger: silentLogger(), now });
    const count = await restarted.drain(async () => ({ status: 'delivered', responseStatus: 200 }));

    expect(count).toBe(1);
  });

  it('prunes settled deliveries last updated before the cutoff and keeps pending ones', async () => {
    const { db, instance, queue } = await setupQueue();
    for (const [id, status] of [['delivered', 'delivered'], ['failed', 'failed'], ['pending', 'pending']]) {
      await queue.enqueue(job(instance.id, { id, dedupeKey: id }));
      await db.webhookDelivery.update({ where: { id }, data: { status } });
    }

    expect(await queue.pruneFinished(new Date(Date.now() - 60_000))).toBe(0);
    expect(await queue.pruneFinished(new Date(Date.now() + 60_000))).toBe(2);
    expect((await db.webhookDelivery.findMany()).map((row) => row.id)).toEqual(['pending']);
  });
});
