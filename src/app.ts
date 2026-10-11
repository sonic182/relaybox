import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import type { Logger } from 'pino';
import { requireAuth, requireSameOrigin } from './auth';
import { home, login, logout, showLogin } from './controllers/auth';
import { createDashboardController } from './controllers/dashboard';
import { redoc, swaggerJson } from './controllers/documentation';
import { LOG_FORMAT, LOG_LEVEL } from './config';
import { createChatsController } from './controllers/chats';
import { createInstancesController } from './controllers/instances';
import { createMediaController } from './controllers/media';
import { demo, show, tick } from './controllers/ui';
import { createWebhooksController } from './controllers/webhooks';
import type { ChatService } from './chats';
import type { InstanceService } from './instances';
import { createLogger } from './logger';
import type { SendService } from './sends';
import type { WebhookService } from './webhooks';
import { API_PREFIXES, createApiRouter } from './api/router';
import type { ControlService } from './api/control';
import type { SettingsService } from './settings';
import { createSettingsController } from './controllers/settings';

type AppDependencies = {
  instanceService: InstanceService;
  webhookService: WebhookService;
  settingsService: SettingsService;
  chatService: ChatService;
  sendService: SendService;
  /** The runtime bootstrap supplies this; tests may use the configured default. */
  logger?: Logger;
  /** Shared with the remote socket, so both transports validate and dispatch identically. */
  controlService: ControlService;
};

/** Builds the HTTP app without binding a TCP port. */
export function createApp({
  instanceService,
  webhookService,
  settingsService,
  chatService,
  sendService,
  logger = createLogger(LOG_LEVEL, undefined, LOG_FORMAT),
  controlService,
}: AppDependencies) {
  const app = express();
  const dashboard = createDashboardController(instanceService);
  const instances = createInstancesController(instanceService, controlService);
  const settings = createSettingsController(settingsService);
  const webhooks = createWebhooksController(webhookService);
  const chats = createChatsController(chatService, instanceService);
  const media = createMediaController(chatService);

  app.use(express.static('public'));
  // Documentation is public and describes the API; it does not call any integrations.
  app.get('/swagger.json', swaggerJson);
  app.get('/redoc', redoc);
  app.use(
    pinoHttp({
      logger,
      // Query strings can carry signed-media bearer credentials, including on rejected requests.
      serializers: {
        req: (req) => ({ ...req, url: req.url?.split('?')[0], query: undefined }),
      },
      genReqId: (_req, res) => {
        const requestId = randomUUID();
        res.setHeader('X-Request-Id', requestId);
        return requestId;
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Evolution-compatible JSON API: its own apikey auth and error format.
  app.use(API_PREFIXES, createApiRouter({ instanceService, chatService, sendService, logger, controlService }));
  app.use(requireSameOrigin);

  app.get('/', home);
  app.get('/login', showLogin);
  app.post('/login', login);
  app.get('/dashboard', requireAuth, dashboard.showDashboard);
  app.get('/instances/events', requireAuth, instances.events);
  app.get('/instances', requireAuth, instances.list);
  app.post('/instances', requireAuth, instances.create);
  app.post('/instances/:name/rename', requireAuth, instances.rename);
  app.post('/instances/:name/delete', requireAuth, instances.deleteOne);
  app.post('/instances/:name/disconnect', requireAuth, instances.disconnect);
  app.post('/instances/:name/connect', requireAuth, instances.reconnect);
  app.post('/instances/:name/unpair', requireAuth, instances.unpair);
  app.get('/instances/:name/settings', requireAuth, settings.show);
  app.post('/instances/:name/settings', requireAuth, settings.save);
  app.get('/instances/:name/chats', requireAuth, chats.show);
  app.get('/instances/:name/chats/events', requireAuth, chats.events);
  app.get('/instances/:name/chats/avatar', requireAuth, chats.avatar);
  app.get('/instances/:name/chats/messages', requireAuth, chats.messages);
  app.get('/instances/:name/media/:keyId', requireAuth, chats.media);
  // Signature-authenticated counterpart for MCP: a caller fetches media without the API key.
  app.get('/media/:instanceName/:keyId', media.byToken);
  app.post('/instances/:name/chats/send', requireAuth, chats.send);
  app.get('/instances/:name/webhook', requireAuth, webhooks.show);
  app.post('/instances/:name/webhook', requireAuth, webhooks.save);

  // Component gallery, kept out of production builds.
  if (process.env.NODE_ENV !== 'production') {
    app.get('/ui', show);
    app.post('/ui/demo', demo);
    app.get('/ui/tick', tick);
  }

  app.post('/logout', logout);

  return app;
}
