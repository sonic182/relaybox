import type { Logger } from 'pino';
import { WebSocket } from 'ws';
import type { RemoteTarget } from './config';
import { apiErrorBody } from './contracts/evolution';
import { apiErrorResponse, badRequest, mapApiError } from './api/error-core';
import type { ControlService } from './api/control';
import { backoffMs } from './queue';

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
/** How long a connection must hold before it counts as healthy and the backoff resets. */
const STABLE_CONNECTION_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
/** Shutdown has a 10s budget in src/index.ts; ws would otherwise wait 30s for a close frame. */
const CLOSE_GRACE_MS = 2_000;
/**
 * How long stop() lets running operations answer before closing: outlasts the 2s connect wait in
 * control.ts. With CLOSE_GRACE_MS that is about 5s, run alongside the delivery worker's stop.
 */
const DRAIN_MS = 3_000;
const MAX_FRAME_BYTES = 1024 * 1024 + 64 * 1024;

export type RemoteClient = {
  start(): void;
  /** Briefly lets running control operations answer, then closes the socket. */
  stop(): Promise<void>;
};

/**
 * The control socket is outbound: Relaybox dials the remote server, so no inbound route is
 * exposed and no port has to be reachable. The token travels in the upgrade header, never in the
 * URL, and only the hostname is ever logged.
 *
 * Control frames call the shared service directly; no local HTTP request is made.
 */
export function createRemoteClient({ target, logger, control }: { target: RemoteTarget; logger: Logger; control: ControlService }): RemoteClient {
  const host = target.url.hostname;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let stopped = false;
  const inFlight = new Set<Promise<void>>();

  function connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(target.url, {
        headers: { Authorization: `Bearer ${target.token}` },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_FRAME_BYTES,
      });
    } catch (err) {
      // The constructor throws on a URL `parseRemoteTarget` let through. Giving up beats
      // retrying a value that cannot work, and beats taking the process down from a timer.
      logger.error({ err, host }, 'remote control disabled: the server URL was rejected');
      return;
    }
    socket = ws;
    let openedAt = 0;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let pongTimer: NodeJS.Timeout | undefined;

    function scheduleHeartbeat(): void {
      heartbeatTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.ping();
        pongTimer = setTimeout(() => {
          logger.warn({ host }, 'remote control heartbeat timed out');
          ws.terminate();
        }, PONG_TIMEOUT_MS);
        pongTimer.unref();
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();
    }

    ws.on('open', () => {
      openedAt = Date.now();
      logger.info({ host }, 'remote control connected');
      scheduleHeartbeat();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        logger.warn({ host }, 'remote control ignored binary frame');
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        logger.warn({ host }, 'remote control ignored invalid JSON frame without request ID');
        return;
      }
      if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
        logger.warn({ host }, 'remote control ignored non-object frame');
        return;
      }
      const value = frame as Record<string, unknown>;
      const requestId = value.requestId;
      if (typeof requestId !== 'string' || !requestId.length) {
        logger.warn({ host }, 'remote control ignored frame without request ID');
        return;
      }
      const send = (status: number, body: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response', requestId, status, body }));
      };
      // The socket stays open while running operations drain; tell the remote this one was not
      // applied rather than leave it to time out.
      if (stopped) {
        send(503, apiErrorBody(503, 'Service Unavailable', 'Server is shutting down'));
        return;
      }
      if (value.type !== 'request' || typeof value.method !== 'string' || typeof value.path !== 'string'
        || !value.method || !value.path) {
        const response = apiErrorResponse(badRequest('Invalid request frame'));
        send(response.status, response.body);
        return;
      }
      const execution = control.execute({ method: value.method, path: value.path, body: value.body }).then(
        (response) => send(response.status, response.body),
        (error: unknown) => {
          const mapped = mapApiError(error);
          if (mapped) {
            const response = apiErrorResponse(mapped);
            send(response.status, response.body);
          } else {
            logger.error({ err: error, host }, 'remote control request failed');
            send(500, apiErrorBody(500, 'Internal Server Error', 'Internal Server Error'));
          }
        },
      );
      inFlight.add(execution);
      void execution.then(
        () => { inFlight.delete(execution); },
        (error: unknown) => {
          inFlight.delete(execution);
          logger.error({ err: error, host }, 'remote control response failed');
        },
      );
    });

    ws.on('pong', () => {
      if (!pongTimer) return;
      clearTimeout(pongTimer);
      pongTimer = undefined;
      scheduleHeartbeat();
    });

    // 'error' always precedes 'close', so reconnecting from 'close' alone covers both a refused
    // handshake and a dropped connection without scheduling two attempts for one failure.
    ws.on('error', (err) => {
      // Closing mid-handshake aborts it through this path; during shutdown that is not a fault.
      if (!stopped) logger.warn({ err, host }, 'remote control socket error');
    });

    ws.on('close', (code) => {
      clearTimeout(heartbeatTimer);
      clearTimeout(pongTimer);
      socket = undefined;
      if (stopped) return;

      // Reset only after a connection that held: a peer that accepts the upgrade and drops it
      // at once would otherwise keep the delay pinned at the base and never back off.
      if (openedAt && Date.now() - openedAt >= STABLE_CONNECTION_MS) attempts = 0;
      const delay = backoffMs(attempts++, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS);
      logger.warn({ code, delay, host }, 'remote control disconnected; reconnecting');
      reconnectTimer = setTimeout(connect, delay);
      // The remote server is optional infrastructure: a pending retry must not keep the process up.
      reconnectTimer.unref();
    });
  }

  return {
    start: () => {
      // Before the guard: a start() racing an unawaited stop() must revive the client rather
      // than be swallowed, otherwise the pending 'close' would schedule nothing and die quietly.
      stopped = false;
      // One socket at a time: a second would be unreachable, and whichever closed first would
      // clear `socket` and make stop() report success while the other stayed connected.
      if (socket || reconnectTimer) return;

      connect();
    },
    stop: async () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;

      // Drain while the socket is still open, so an operation that finishes can still tell the
      // remote its outcome; `stopped` already keeps new frames out.
      if (inFlight.size) {
        let drainTimer: NodeJS.Timeout | undefined;
        const drained = await Promise.race([
          Promise.allSettled([...inFlight]).then(() => true),
          new Promise<false>((resolve) => {
            drainTimer = setTimeout(() => resolve(false), DRAIN_MS);
            drainTimer.unref();
          }),
        ]);
        clearTimeout(drainTimer);
        if (!drained) logger.warn({ host, inFlight: inFlight.size }, 'remote control shutdown drain timed out');
      }

      // Read again: the remote may have dropped the socket during the drain.
      const ws = socket;
      if (!ws || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        // A half-open connection never answers the close frame, and ws waits 30s for it.
        const forceClose = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
        forceClose.unref();
        ws.once('close', () => {
          clearTimeout(forceClose);
          resolve();
        });
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
      });
    },
  };
}
