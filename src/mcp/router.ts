import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { secretEquals } from '../auth';
import { API_KEY, MCP_INLINE_MEDIA_BYTES } from '../config';
import { apiErrorBody } from '../contracts/evolution';
import { createMcpServer, createMcpTools, selectMcpTools, type McpDependencies } from './server';

/** Room for the largest inline media payload plus the JSON-RPC envelope around it. */
const MCP_JSON_LIMIT = Math.ceil((MCP_INLINE_MEDIA_BYTES * 4) / 3) + 64 * 1024;

/**
 * Bearer-token auth using the app's single credential. No OAuth challenge is returned, so a
 * client configured with a static token does not fall into an OAuth discovery loop.
 */
export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  if (secretEquals(token, API_KEY)) return next();
  res.status(401).json(apiErrorBody(401, 'Unauthorized', 'Unauthorized'));
}

export type McpRouterOptions = {
  /** Hostnames allowed for a non-localhost bind; omitted keeps the localhost-only guard. */
  allowedHosts?: string[];
};

/** Mountable MCP router: host/origin guards, Bearer auth, then the Streamable HTTP handler. */
export function createMcpRouter(deps: McpDependencies, { allowedHosts = [] }: McpRouterOptions = {}): Router {
  selectMcpTools(createMcpTools(deps), deps.toolFilter);
  const handler = createMcpHandler(() => createMcpServer(deps), {
    onerror: (error) => deps.logger.warn({ err: error }, 'mcp request failed'),
  });
  const nodeHandler = toNodeHandler(handler);

  const router = express.Router();
  if (allowedHosts.length) {
    router.use(hostHeaderValidation(allowedHosts));
    router.use(originValidation(allowedHosts));
  } else {
    router.use(localhostHostValidation());
    router.use(localhostOriginValidation());
  }
  router.use(requireMcpAuth);
  router.use(express.json({ limit: MCP_JSON_LIMIT }));
  // `req.body` is passed explicitly; letting Express supply `next` as the third argument
  // would hand the transport a function where it expects a parsed body.
  router.all('/', (req: Request, res: Response) => nodeHandler(req, res, req.body));
  return router;
}
