import type { JsonObject } from '@zenstackhq/orm';
import type { AuthenticationState, AuthenticationCreds, SignalDataSet } from 'baileys';
import type { Db } from './db';

type StoredKeys = Record<string, Record<string, unknown>>;
type BaileysAuthHelpers = {
  BufferJSON: { replacer(key: string, value: unknown): unknown; reviver(key: string, value: unknown): unknown };
  initAuthCreds(): AuthenticationCreds;
  proto: { Message: { AppStateSyncKeyData: { fromObject(value: unknown): unknown } } };
};

function encode(value: unknown, { BufferJSON }: BaileysAuthHelpers): JsonObject {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as JsonObject;
}

function decode<T>(value: unknown, { BufferJSON }: BaileysAuthHelpers): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

/** Baileys auth storage backed by the instance's durable PostgreSQL record. */
export async function createPostgresAuthState(db: Db, instanceId: string, helpers: BaileysAuthHelpers): Promise<{
  state: AuthenticationState;
  saveCreds(): Promise<void>;
}> {
  const saved = await db.baileysAuthState.findUnique({ where: { instanceId } });
  const creds = saved ? decode<AuthenticationCreds>(saved.creds, helpers) : helpers.initAuthCreds();
  const keys = saved ? decode<StoredKeys>(saved.keys, helpers) : {};
  let writes = Promise.resolve();

  function persist(): Promise<void> {
    const write = writes.then(() =>
      db.baileysAuthState.upsert({
        where: { instanceId },
        create: { instanceId, creds: encode(creds, helpers), keys: encode(keys, helpers) },
        update: { creds: encode(creds, helpers), keys: encode(keys, helpers) },
      }),
    );
    writes = write.then(() => undefined, () => undefined);
    return write.then(() => undefined);
  }

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const values = keys[type] ?? {};
          const result: Record<string, unknown> = {};
          for (const id of ids) {
            let value = values[id];
            if (type === 'app-state-sync-key' && value) {
              value = helpers.proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[id] = value;
          }
          return result as never;
        },

        async set(data: SignalDataSet) {
          for (const [type, values] of Object.entries(data)) {
            if (!values) continue;
            const stored = (keys[type] ??= {});
            for (const [id, value] of Object.entries(values)) {
              if (value === null) delete stored[id];
              else stored[id] = value;
            }
          }
          await persist();
        },
      },
    },
    saveCreds: persist,
  };
}

export function clearPostgresAuthState(db: Db, instanceId: string): Promise<unknown> {
  return db.baileysAuthState.deleteMany({ where: { instanceId } });
}
