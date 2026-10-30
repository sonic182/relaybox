import type { Settings, SettingsInput } from './contracts/evolution';
import type { Db } from './db';
import { InstanceNotFoundError } from './webhooks';

const DEFAULT_SETTINGS: Settings = { syncFullHistory: false, alwaysOnline: false };
const SETTINGS_FIELDS = { syncFullHistory: true, alwaysOnline: true } as const;

/** Pushes a changed `alwaysOnline` to the instance's live socket, if it has one. */
export type PresenceApplier = (instanceName: string, alwaysOnline: boolean) => Promise<void>;

export type SettingsService = {
  /** Defaults when the instance has no stored row; rejects an unknown instance. */
  getSettings(instanceName: string): Promise<Settings>;
  /** Stores only the given settings; the others keep their stored or default value. */
  setSettings(instanceName: string, settings: SettingsInput): Promise<Settings>;
};

/** The stored settings of an instance, or the defaults without a stored row. */
export async function readSettings(db: Db, instanceId: string): Promise<Settings> {
  const row = await db.instanceSettings.findUnique({ where: { instanceId }, select: SETTINGS_FIELDS });
  return row ?? { ...DEFAULT_SETTINGS };
}

/** Whether history received while pairing should be imported; off without a stored row. */
export async function isHistorySyncEnabled(db: Db, instanceId: string): Promise<boolean> {
  return (await readSettings(db, instanceId)).syncFullHistory;
}

export function createSettingsService({ db, applyPresence }: { db: Db; applyPresence?: PresenceApplier }): SettingsService {
  const requireInstance = async (instanceName: string) => {
    const instance = await db.instanceRecord.findUnique({ where: { name: instanceName }, select: { id: true } });
    if (!instance) throw new InstanceNotFoundError(instanceName);
    return instance;
  };

  return {
    async getSettings(instanceName) {
      const instance = await requireInstance(instanceName);
      return readSettings(db, instance.id);
    },

    async setSettings(instanceName, { syncFullHistory, alwaysOnline }) {
      const instance = await requireInstance(instanceName);
      const data = {
        ...(syncFullHistory !== undefined ? { syncFullHistory } : {}),
        ...(alwaysOnline !== undefined ? { alwaysOnline } : {}),
      };
      const row = await db.instanceSettings.upsert({
        where: { instanceId: instance.id },
        create: { instanceId: instance.id, ...data },
        update: data,
        select: SETTINGS_FIELDS,
      });
      // The socket only reads the setting when it connects, so a change must reach it now.
      if (alwaysOnline !== undefined) await applyPresence?.(instanceName, row.alwaysOnline);
      return row;
    },
  };
}
