import { WebSocketServer, type WebSocket } from 'ws';

export type FakeTarget = {
  url: URL;
  /** Resolves with the `authorization` header of the nth connection, counting from 1. */
  connection(nth: number): Promise<string | undefined>;
  sockets: WebSocket[];
  close(): Promise<void>;
};

/** Stands in for the remote server: accepts upgrades and records what arrived on each one. */
export async function createFakeTarget(autoPong = true): Promise<FakeTarget> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong });
  const received: (string | undefined)[] = [];
  const waiting = new Map<number, (authorization: string | undefined) => void>();
  const sockets: WebSocket[] = [];

  server.on('connection', (socket, req) => {
    sockets.push(socket);
    received.push(req.headers.authorization);
    waiting.get(received.length)?.(req.headers.authorization);
  });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake target did not bind a TCP port');

  return {
    url: new URL(`ws://127.0.0.1:${address.port}/relaybox`),
    connection: (nth) =>
      received.length >= nth
        ? Promise.resolve(received[nth - 1])
        : new Promise((resolve) => waiting.set(nth, resolve)),
    sockets,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
