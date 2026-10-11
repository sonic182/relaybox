import { runInNewContext } from 'node:vm';
import { inspect } from 'node:util';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/express';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { ChatService } from './chats';
import type { Db } from './db';
import type { InstanceService } from './instances';
import { isLoopbackHost } from './net';
import type { Logger } from 'pino';

type DevMcpDependencies = {
  db: Db;
  instanceService: InstanceService;
  chatService: ChatService;
  logger: Logger;
};

function describe(value: unknown): string {
  return inspect(value, { depth: 5, maxArrayLength: 100, maxStringLength: 10_000, breakLength: 120 });
}

export function requireLoopbackPeer(req: Request, res: Response, next: NextFunction): void {
  const address = req.socket.remoteAddress;
  if (address && isLoopbackHost(address)) return next();
  res.status(403).json({ error: 'The development MCP endpoint only accepts loopback connections' });
}

/**
 * Development-only MCP server. `project_eval` deliberately executes arbitrary code with
 * live services; never enable this outside a local machine you control.
 */
export function createDevMcpRouter(dependencies: DevMcpDependencies): Router {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'relaybox-dev', version: '0.2.0' });

    server.registerTool(
      'runtime_info',
      {
        description: 'Return the live instance snapshots and process information.',
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: 'text',
            text: describe({
              pid: process.pid,
              node: process.version,
              instances: dependencies.instanceService.listInstances(),
            }),
          },
        ],
      }),
    );

    server.registerTool(
      'project_eval',
      {
        description:
          'Execute an async JavaScript body against the live db, instanceService, and chatService. Local development only.',
        inputSchema: z.object({ code: z.string().min(1).max(10_000) }),
      },
      async ({ code }) => {
        const logs: string[] = [];
        const console = {
          log: (...values: unknown[]) => logs.push(values.map(describe).join(' ')),
          error: (...values: unknown[]) => logs.push(values.map(describe).join(' ')),
        };

        try {
          const execution = runInNewContext(
            `(async () => { 'use strict';\n${code}\n})()`,
            { ...dependencies, console },
            { timeout: 5_000 },
          );
          const result = await new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out after 5 seconds')), 5_000);
            Promise.resolve(execution).then(
              (value) => {
                clearTimeout(timeout);
                resolve(value);
              },
              (err: unknown) => {
                clearTimeout(timeout);
                reject(err);
              },
            );
          });
          return {
            content: [{ type: 'text', text: [logs.join('\n'), describe(result)].filter(Boolean).join('\n') }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: describe(err) }], isError: true };
        }
      },
    );

    return server;
  }, { onerror: (err) => dependencies.logger.warn({ err }, 'dev mcp request failed') });

  const router = express.Router();
  router.use(requireLoopbackPeer);
  router.use(localhostHostValidation());
  router.use(localhostOriginValidation());
  router.use(express.json({ limit: '32kb' }));
  router.all('/', (req: Request, res: Response) => toNodeHandler(handler)(req, res, req.body));
  return router;
}
