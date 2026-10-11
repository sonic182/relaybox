import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseUrls } from './database';

// Must be set before application modules import src/config.ts.
process.env.API_KEY = 'test-api-key-0000';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Media tests write real files; keep them out of the working tree.
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'relaybox-media-'));

process.env.DB_URL = testDatabaseUrls().testUrl;
