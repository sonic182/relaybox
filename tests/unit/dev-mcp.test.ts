import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireLoopbackPeer } from '../../src/dev-mcp';

function run(remoteAddress: string | undefined) {
  const req = { socket: { remoteAddress } } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
  const next = vi.fn() as NextFunction;
  requireLoopbackPeer(req, res, next);
  return { res, next };
}

describe('requireLoopbackPeer', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('lets a loopback peer (%s) through', (address) => {
    const { res, next } = run(address);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(['192.168.1.20', '::ffff:10.0.0.5', '172.17.0.1', undefined])('rejects a non-loopback peer (%s)', (address) => {
    const { res, next } = run(address);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
