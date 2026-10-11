import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createEventStreams } from '../../src/controllers/sse';

function stream() {
  const req = new EventEmitter();
  const res = { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), end: vi.fn(), flushHeaders: vi.fn() };
  return { req, res, args: [req as unknown as Request, res as unknown as Response] as const };
}

describe('createEventStreams', () => {
  it('refuses streams over the limit until one closes', () => {
    const streams = createEventStreams(2);
    const first = stream();
    const second = stream();
    const third = stream();

    expect(streams.open(...first.args)).toBe(true);
    expect(streams.open(...second.args)).toBe(true);
    expect(streams.open(...third.args)).toBe(false);
    expect(third.res.status).toHaveBeenCalledWith(503);
    expect(third.res.flushHeaders).not.toHaveBeenCalled();

    first.req.emit('close');
    expect(streams.open(...stream().args)).toBe(true);
  });
});
