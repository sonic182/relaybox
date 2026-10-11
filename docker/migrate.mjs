import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? '/app/zenstack/migrations';

const client = new pg.Client({ connectionString: process.env.DB_URL });

await client.connect();
try {
    // Tracker is _prisma_migrations so applied migrations match what ZenStack/Prisma records.
    await client.query(
        'CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)',
    );

    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

    for (const name of migrations) {
        const { rowCount } = await client.query(
            'SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL',
            [name],
        );
        if (rowCount) continue;

        const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 64);
        await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query(
                'INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count") VALUES ($1, $2, now(), $3, 1)',
                [randomUUID(), checksum, name],
            );
            await client.query('COMMIT');
            console.log(`applied migration ${name}`);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
    }
} finally {
    await client.end();
}