import express, { Router } from 'express';
import type { Logger } from 'pino';
import type { ChatService } from '../chats';
import type { ControlService } from './control';
import { MAX_OUTBOUND_MEDIA_BYTES } from '../config';
import type { InstanceService } from '../instances';
import type { SendService } from '../sends';
import { requireApiKey } from './auth';
import { createChatRoutes } from './chat';
import { apiNotFound, createApiErrorHandler } from './errors';
import { createInstanceRoutes } from './instance';
import { createMessageRoutes } from './message';
import { createSettingsRoutes } from './settings';
import { createWebhookRoutes } from './webhook';

type ApiDependencies = {
  instanceService: InstanceService;
  chatService: ChatService;
  sendService: SendService;
  logger: Logger;
  controlService: ControlService;
};

/**
 * Mount points of the Evolution-compatible JSON API. Anything not listed here stays
 * unmounted and is handled by the HTML app, not silently answered with wrong data.
 */
export const API_PREFIXES = ['/instance', '/message', '/webhook', '/chat', '/settings'];
const MEDIA_JSON_LIMIT = Math.ceil((MAX_OUTBOUND_MEDIA_BYTES * 4) / 3) + 64 * 1024;

/** JSON API, separate from the HTML/htmx routes but sharing the application services. */
export function createApiRouter({ instanceService, chatService, sendService, logger, controlService }: ApiDependencies): Router {
  const router = Router();

  router.use(['/sendMedia', '/sendWhatsAppAudio'], requireApiKey, express.json({ limit: MEDIA_JSON_LIMIT }));
  router.use(express.json({ limit: '1mb' }));
  router.use(requireApiKey);

  // Express strips the matched prefix, so route groups register their paths directly.
  router.use(createInstanceRoutes(controlService));
  router.use(createMessageRoutes(instanceService, sendService));
  router.use(createChatRoutes(instanceService, sendService, chatService));
  router.use(createWebhookRoutes(controlService));
  router.use(createSettingsRoutes(controlService));

  router.use(apiNotFound);
  router.use(createApiErrorHandler(logger));

  return router;
}
