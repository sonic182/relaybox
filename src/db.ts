import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ZenStackClient } from '@zenstackhq/orm';
import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { schema } from '../zenstack/schema';
import { DB_URL } from './config';

const MIGRATIONS_DIR = 'zenstack/migrations';

export function createDatabasePool(connectionString = DB_URL): Pool {
  return new Pool({ connectionString });
}

/** Applies every committed migration in order; used for the isolated test database. */
export async function applyMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<void> {
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of migrations) {
    await pool.query(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
  }
}

export function createDb(pool: Pool = createDatabasePool()) {
  return new ZenStackClient(schema, { dialect: new PostgresDialect({ pool }) });
}

export type Db = ReturnType<typeof createDb>;
