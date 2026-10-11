import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db';
import type { InboundMessage } from '../../src/instances';
import { SendInProgressError, createSendService } from '../../src/sends';
import { createTestDbWithInstance, silentLogger } from '../helpers';

let instanceNumber = 0;

async function setup() {
  const { db, instance } = await createTestDbWithInstance(`acme-${++instanceNumber}`);
  return { db, instanceId: instance.id, service: createSendService({ db, logger: silentLogger() }) };
}

/** The same client with only `sendRequest.update` broken; ZenStack's models are proxies. */
function withFailingUpdate(db: Db): Db {
  const bind = (target: object, prop: string | symbol) => {
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };

  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'sendRequest') return bind(target, prop);

      return new Proxy(Reflect.get(target, prop) as object, {
        get: (model, key) =>
          key === 'update' ? () => Promise.reject(new Error('write failed')) : bind(model, key),
      });
    },
  }) as Db;
}

function message(id = 'SENT-1'): InboundMessage {
  return {
    key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id },
    message: { conversation: 'hola' },
    messageType: 'conversation',
    messageTimestamp: 1756555200,
    instanceId: 'instance-1',
  };
}

describe('send idempotency', () => {
  it('sends once and replays the stored response', async () => {
    const { instanceId, service } = await setup();
    const send = vi.fn(async () => message());

    const first = await service.once(instanceId, 'key-1', send);
    const second = await service.once(instanceId, 'key-1', send);

    expect(send).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it('treats a different key as a different send', async () => {
    const { instanceId, service } = await setup();
    const send = vi.fn(async () => message());

    await service.once(instanceId, 'key-1', send);
    await service.once(instanceId, 'key-2', send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  // A key belongs to its instance, so two instances can use the same one.
  it('scopes a key to its instance', async () => {
    const { db, instanceId, service } = await setup();
    const other = await db.instanceRecord.create({ data: { name: `globex-${++instanceNumber}` } });
    const send = vi.fn(async () => message());

    await service.once(instanceId, 'key-1', send);
    await service.once(other.id, 'key-1', send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends every time when no key is given', async () => {
    const { instanceId, service } = await setup();
    const send = vi.fn(async () => message());

    await service.once(instanceId, undefined, send);
    await service.once(instanceId, undefined, send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  // Blocking the key forever would make a transient WhatsApp failure unrecoverable.
  it('releases the key when the send fails, so a retry can retry', async () => {
    const { instanceId, service } = await setup();
    const send = vi
      .fn<() => Promise<InboundMessage>>()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(message('SENT-2'));

    await expect(service.once(instanceId, 'key-1', send)).rejects.toThrow('socket closed');
    const retried = await service.once(instanceId, 'key-1', send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(retried.key.id).toBe('SENT-2');
  });

  it('refuses a retry that arrives while the first send is still in flight', async () => {
    const { instanceId, service } = await setup();
    let release = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = service.once(instanceId, 'key-1', async () => {
      await inFlight;
      return message();
    });

    await expect(service.once(instanceId, 'key-1', async () => message())).rejects.toBeInstanceOf(
      SendInProgressError,
    );

    release();
    await expect(first).resolves.toMatchObject({ key: { id: 'SENT-1' } });
  });

  // Reporting every write failure as a conflict would hide a real fault behind a 409.
  it('surfaces a claim failure that is not a taken key', async () => {
    const { service } = await setup();
    const send = vi.fn(async () => message());

    await expect(service.once('no-such-instance', 'key-1', send)).rejects.not.toBeInstanceOf(SendInProgressError);
    expect(send).not.toHaveBeenCalled();
  });

  // The message is already gone, so releasing the key here would send it twice. A 409 is
  // the safe way to be wrong.
  it('keeps the claim when the message went out but the response could not be recorded', async () => {
    const { db, instanceId } = await setup();
    // Everything but the response write still goes to the real database, so the claim
    // and the retry are checked against the actual unique constraint.
    const service = createSendService({ db: withFailingUpdate(db), logger: silentLogger() });
    const send = vi.fn(async () => message());

    await expect(service.once(instanceId, 'key-1', send)).resolves.toMatchObject({ key: { id: 'SENT-1' } });

    await expect(service.once(instanceId, 'key-1', send)).rejects.toBeInstanceOf(SendInProgressError);
    expect(send).toHaveBeenCalledOnce();
  });

  it('replays once the in-flight send has finished', async () => {
    const { instanceId, service } = await setup();
    const send = vi.fn(async () => message());

    await service.once(instanceId, 'key-1', send);
    const replayed = await service.once(instanceId, 'key-1', send);

    expect(send).toHaveBeenCalledOnce();
    expect(replayed).toEqual(message());
  });

  it('prunes old completed responses but retains in-flight claims', async () => {
    const { db, instanceId, service } = await setup();
    await service.once(instanceId, 'completed', async () => message());
    await db.sendRequest.create({ data: { instanceId, idempotencyKey: 'in-flight' } });

    expect(await service.pruneCompleted(new Date(0))).toBe(0);
    expect(await service.pruneCompleted(new Date(Date.now() + 1000))).toBe(1);
    expect(await db.sendRequest.findUnique({
      where: { instanceId_idempotencyKey: { instanceId, idempotencyKey: 'completed' } },
    })).toBeNull();
    expect(await db.sendRequest.findUnique({
      where: { instanceId_idempotencyKey: { instanceId, idempotencyKey: 'in-flight' } },
    })).not.toBeNull();
  });
});
