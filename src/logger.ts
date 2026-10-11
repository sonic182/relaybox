import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_FORMATS = ['json', 'logfmt', 'pretty'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/** Fields that can contain credentials, cookies, webhook secrets, or message bodies. */
export const LOG_REDACT_PATHS = [
  'req.headers',
  'res.headers',
  'headers',
  '*.headers',
  'message',
  'messages',
] as const;

/** Parses the process-level severity threshold before the server starts. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const level = value?.trim().toLowerCase() || 'info';
  if ((LOG_LEVELS as readonly string[]).includes(level)) return level as LogLevel;

  throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
}

export function parseLogFormat(value: string | undefined): LogFormat {
  const format = value?.trim().toLowerCase() || (process.env.NODE_ENV !== 'production' && process.stdout.isTTY ? 'pretty' : 'json');
  if ((LOG_FORMATS as readonly string[]).includes(format)) return format as LogFormat;

  throw new Error(`LOG_FORMAT must be one of: ${LOG_FORMATS.join(', ')}`);
}

function quoteLogfmt(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Converts one structured Pino record to a logfmt line. */
export function toLogfmt(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([key, value]) => {
      const name = key.replace(/[^A-Za-z0-9_.-]/g, '_');
      const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${name}=${quoteLogfmt(text)}`;
    })
    .join(' ');
}

function logfmtStream(): Writable {
  let buffer = '';
  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      try {
        for (const line of lines) {
          if (line) process.stdout.write(`${toLogfmt(JSON.parse(line))}\n`);
        }
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}

/** Creates JSON, logfmt, or pretty logs; optional files always retain structured JSON. */
export function createLogger(level: LogLevel, logDirectory?: string, format: LogFormat = 'json'): Logger {
  const options: LoggerOptions = {
    level,
    // `level=30` says nothing at a glance, and it makes grepping for errors a lookup.
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...LOG_REDACT_PATHS], remove: true },
  };

  const consoleStream =
    format === 'logfmt'
      ? logfmtStream()
      : format === 'pretty' && process.stdout.isTTY
        ? pino.transport({ target: 'pino-pretty' })
        : process.stdout;

  if (!logDirectory) return pino(options, consoleStream);

  // Every multistream entry carries its own threshold, defaulting to info. Without this
  // the logger's own level is overruled and anything below info is silently dropped.
  return pino(
    options,
    pino.multistream([
      { stream: consoleStream, level },
      {
        level,
        stream: pino.destination({
          dest: join(logDirectory, 'app.log'),
          mkdir: true,
          sync: false,
        }),
      },
    ]),
  );
}
