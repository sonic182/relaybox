import { Pool } from 'pg';
import { testDatabaseUrls } from './database';

export default async function globalSetup(): Promise<void> {
  process.env.API_KEY = 'test-api-key-0000';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  const { sourceUrl, testUrl } = testDatabaseUrls();
  process.env.DB_URL = testUrl;

  const { applyMigrations, createDatabasePool } = await import('../src/db');
  const adminPool = new Pool({ connectionString: sourceUrl });
  const pool = createDatabasePool();
  try {
    const { rowCount } = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', ['relaybox_test']);
    if (!rowCount) await adminPool.query('CREATE DATABASE relaybox_test');
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await applyMigrations(pool);
  } finally {
    await pool.end();
    await adminPool.end();
  }
}
