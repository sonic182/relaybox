import type { SettingsInput, SettingsResponse } from './contracts/evolution';
import type { Db } from './db';
import { InstanceNotFoundError } from './webhooks';

const DEFAULT_SETTINGS: SettingsResponse = { syncFullHistory: false };

export type SettingsService = {
  /** Defaults when the instance has no stored row; rejects an unknown instance. */
  getSettings(instanceName: string): Promise<SettingsResponse>;
  setSettings(instanceName: string, settings: SettingsInput): Promise<SettingsResponse>;
};

/** Whether history received while pairing should be imported; off without a stored row. */
export async function isHistorySyncEnabled(db: Db, instanceId: string): Promise<boolean> {
  const row = await db.instanceSettings.findUnique({ where: { instanceId }, select: { syncFullHistory: true } });
  return row?.syncFullHistory ?? DEFAULT_SETTINGS.syncFullHistory;
}

export function createSettingsService({ db }: { db: Db }): SettingsService {
  const requireInstance = async (instanceName: string) => {
    const instance = await db.instanceRecord.findUnique({ where: { name: instanceName }, select: { id: true } });
    if (!instance) throw new InstanceNotFoundError(instanceName);
    return instance;
  };

  return {
    async getSettings(instanceName) {
      const instance = await requireInstance(instanceName);
      return { syncFullHistory: await isHistorySyncEnabled(db, instance.id) };
    },

    async setSettings(instanceName, { syncFullHistory }) {
      const instance = await requireInstance(instanceName);
      const row = await db.instanceSettings.upsert({
        where: { instanceId: instance.id },
        create: { instanceId: instance.id, syncFullHistory },
        update: { syncFullHistory },
        select: { syncFullHistory: true },
      });
      return { syncFullHistory: row.syncFullHistory };
    },
  };
}
