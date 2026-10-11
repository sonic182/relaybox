import { describe, expect, it } from 'vitest';
import { transcodeToOpus } from '../../src/audio';
import { InvalidMediaError } from '../../src/mediaFetch';

/** A minimal 8 kHz mono 16-bit wav, so the test needs no fixture binary on disk. */
function wav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
}

describe('transcodeToOpus', () => {
  it('produces an ogg container WhatsApp will render as a voice note', async () => {
    const output = await transcodeToOpus(wav(8000));

    expect(output.subarray(0, 4).toString()).toBe('OggS');
    expect(output.includes(Buffer.from('OpusHead'))).toBe(true);
  });

  it('rejects unreadable bytes as invalid media rather than failing the request', async () => {
    await expect(transcodeToOpus(Buffer.from('not audio at all'))).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('refuses a decodable format outside the input whitelist', async () => {
    const samples = Buffer.alloc(16000);
    const header = Buffer.alloc(24);
    header.write('.snd', 0);
    header.writeUInt32BE(24, 4);
    header.writeUInt32BE(samples.byteLength, 8);
    header.writeUInt32BE(3, 12);
    header.writeUInt32BE(8000, 16);
    header.writeUInt32BE(1, 20);

    await expect(transcodeToOpus(Buffer.concat([header, samples]))).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('gives up on a payload that will not convert in time', async () => {
    await expect(transcodeToOpus(wav(48000), { timeoutMs: 1 })).rejects.toThrow(/timed out/);
  });
});
