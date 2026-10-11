import type { Request, Response } from 'express';

export const MAX_EVENT_STREAMS = 50;

export type EventStreams = {
  open(req: Request, res: Response): boolean;
};

export function createEventStreams(limit = MAX_EVENT_STREAMS): EventStreams {
  let active = 0;

  return {
    open(req, res) {
      if (active >= limit) {
        res.status(503).set('Retry-After', '30').end();
        return false;
      }

      active += 1;
      req.once('close', () => {
        active -= 1;
      });
      res.set({
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      res.flushHeaders();
      return true;
    },
  };
}
