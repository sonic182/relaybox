import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, parseLogFormat, parseLogLevel, toLogfmt } from '../../src/logger';

describe('parseLogLevel', () => {
  it('defaults to info and normalizes configured values', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel(' DEBUG ')).toBe('debug');
  });

  it('rejects an unsupported logging level', () => {
    expect(() => parseLogLevel('verbose')).toThrow(
      'LOG_LEVEL must be one of: fatal, error, warn, info, debug, trace, silent',
    );
  });

  it('writes JSON logs to an optional directory', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'relaybox-logs-'));
    const logger = createLogger('info', logDirectory);

    try {
      logger.info({ persisted: true }, 'persisted log');

      await expect
        .poll(
          () => {
            try {
              return readFileSync(join(logDirectory, 'app.log'), 'utf8');
            } catch {
              return '';
            }
          },
          { timeout: 1000 },
        )
        .toContain('persisted log');
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });

  // `level=30` says nothing at a glance and makes grepping for errors a lookup.
  it('names the level instead of numbering it', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'relaybox-logs-'));
    const logger = createLogger('info', logDirectory);

    try {
      logger.warn('a warning');

      await expect
        .poll(
          () => {
            try {
              return readFileSync(join(logDirectory, 'app.log'), 'utf8');
            } catch {
              return '';
            }
          },
          { timeout: 1000 },
        )
        .toContain('"level":"warn"');
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });

  // Each multistream entry has its own threshold, defaulting to info, so a file
  // destination silently swallowed everything below it.
  it('honours a debug level when writing to a directory', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'relaybox-logs-'));
    const logger = createLogger('debug', logDirectory);

    try {
      logger.debug({ persisted: true }, 'debug detail');
      logger.info({ persisted: true }, 'info detail');

      await expect
        .poll(
          () => {
            try {
              return readFileSync(join(logDirectory, 'app.log'), 'utf8');
            } catch {
              return '';
            }
          },
          { timeout: 1000 },
        )
        .toContain('debug detail');
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });

  it('still drops records below the configured level', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'relaybox-logs-'));
    const logger = createLogger('warn', logDirectory);

    try {
      logger.info({ persisted: true }, 'info detail');
      logger.warn({ persisted: true }, 'warn detail');

      await expect
        .poll(
          () => {
            try {
              return readFileSync(join(logDirectory, 'app.log'), 'utf8');
            } catch {
              return '';
            }
          },
          { timeout: 1000 },
        )
        .toContain('warn detail');
      expect(readFileSync(join(logDirectory, 'app.log'), 'utf8')).not.toContain('info detail');
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });

  it('removes message bodies, webhook headers, credentials, and response cookies', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'relaybox-logs-'));
    const logger = createLogger('info', logDirectory);

    try {
      logger.info(
        {
          message: { conversation: 'message-secret' },
          messages: [{ message: { conversation: 'batch-secret' } }],
          webhook: { headers: { 'X-Hook-Token': 'header-secret' } },
          req: { headers: { apikey: 'api-secret', cookie: 'cookie-secret' } },
          res: { headers: { 'set-cookie': 'response-cookie-secret' } },
        },
        'redaction check',
      );

      await expect
        .poll(
          () => {
            try {
              return readFileSync(join(logDirectory, 'app.log'), 'utf8');
            } catch {
              return '';
            }
          },
          { timeout: 1000 },
        )
        .toContain('redaction check');
      const output = readFileSync(join(logDirectory, 'app.log'), 'utf8');
      for (const secret of ['message-secret', 'batch-secret', 'header-secret', 'api-secret', 'cookie-secret', 'response-cookie-secret']) {
        expect(output).not.toContain(secret);
      }
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });
});

describe('logfmt', () => {
  it('validates the configured format', () => {
    expect(parseLogFormat(undefined)).toBe('json');
    expect(parseLogFormat(' LOGFMT ')).toBe('logfmt');
    expect(() => parseLogFormat('text')).toThrow('LOG_FORMAT must be one of: json, logfmt, pretty');
  });

  it('quotes values that require it', () => {
    expect(toLogfmt({ level: 'info', msg: 'server listening', context: { port: 3000 } })).toBe(
      'level=info msg="server listening" context="{\\"port\\":3000}"',
    );
  });
});
