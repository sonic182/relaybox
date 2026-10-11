import { spawn } from 'node:child_process';
import { FFMPEG_PATH, MAX_OUTBOUND_MEDIA_BYTES } from './config';
import { InvalidMediaError } from './mediaFetch';

export type TranscodeOptions = {
  /** Headerless 16-bit PCM input, which carries no format ffmpeg could detect on its own. */
  lpcm?: boolean;
  timeoutMs?: number;
  ffmpegPath?: string;
};

/** A voice note that takes this long to convert is a payload we should refuse, not wait on. */
const TRANSCODE_TIMEOUT_MS = 30_000;

const INPUT_FORMATS = 'ogg,mp3,mov,matroska,wav,aac,flac,amr';

/**
 * Encodes arbitrary audio as the ogg/opus WhatsApp expects for a push-to-talk note, with the
 * same settings the reference passes fluent-ffmpeg so the result plays back identically.
 */
export function transcodeToOpus(input: Buffer, { lpcm, timeoutMs = TRANSCODE_TIMEOUT_MS, ffmpegPath = FFMPEG_PATH }: TranscodeOptions = {}): Promise<Buffer> {
  const args = [
    '-protocol_whitelist', 'pipe',
    '-format_whitelist', lpcm ? 's16le' : INPUT_FORMATS,
    ...(lpcm ? ['-f', 's16le', '-ar', '24000', '-ac', '1'] : []),
    '-i', 'pipe:0',
    '-f', 'ogg',
    '-vn',
    '-acodec', 'libopus',
    '-avoid_negative_ts', 'make_zero',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '1',
    '-write_xing', '0',
    '-compression_level', '10',
    '-application', 'voip',
    '-fflags', '+bitexact',
    '-flags', '+bitexact',
    '-id3v2_version', '0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-write_bext', '0',
    'pipe:1',
  ];

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };

    const timeout = setTimeout(() => fail(new InvalidMediaError(`audio conversion timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      // A crafted input can decode to far more than it weighs, so stop at the same cap the
      // inbound bytes were held to rather than buffering whatever ffmpeg produces.
      if (total > MAX_OUTBOUND_MEDIA_BYTES) {
        fail(new InvalidMediaError(`converted audio exceeds the ${MAX_OUTBOUND_MEDIA_BYTES}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    child.once('error', (err) => fail(new Error(`audio conversion failed to start: ${err.message}`)));

    child.once('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;

      // Unreadable bytes are the caller's problem, so report them rather than a 500.
      if (code !== 0) {
        reject(new InvalidMediaError(`"audio" could not be converted: ${lastFfmpegError(stderr)}`));
        return;
      }
      const output = Buffer.concat(chunks);
      if (!output.byteLength) {
        reject(new InvalidMediaError('"audio" converted to an empty file'));
        return;
      }
      resolve(output);
    });

    child.stdin.on('error', () => {
      // ffmpeg closes stdin as soon as it rejects the input; `close` carries the real reason.
    });
    child.stdin.end(input);
  });
}

/** ffmpeg's diagnosis is the last line it prints; the rest is banner and build configuration. */
function lastFfmpegError(stderr: string): string {
  const lines = stderr.trim().split('\n');
  return lines[lines.length - 1]?.trim() || 'unknown ffmpeg error';
}
