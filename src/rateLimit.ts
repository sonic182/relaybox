import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

type RateLimitOptions = {
  limit: number;
  windowMs?: number;
  onLimited?: RequestHandler;
};

export function createRateLimit({ limit, windowMs = 60_000, onLimited }: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(onLimited ? { handler: onLimited } : {}),
  });
}
