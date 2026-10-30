import { createApp } from './app';
import { createControlService, createControlValidator } from './api/control';
import { DELIVERY_CONCURRENCY, DELIVERY_RETENTION_DAYS, ENABLE_MCP_SERVER, LOG_DIRECTORY, LOG_FORMAT, LOG_LEVEL, MCP_ALLOWED_HOSTS, MCP_PATH, MCP_READ_ONLY, MCP_TOOLS, REMOTE_TARGET, isDevelopment } from './config';
import { createDb } from './db';
import { createDeliveryWorker } from './delivery';
import { createInstanceService } from './instances';
import { createLogger } from './logger';
import { createMessageService } from './messages';
import { createOutbox } from './outbox';
import { createDatabaseQueue } from './queue';
import { createChatService } from './chats';
import { createSendService } from './sends';
import { createSettingsService } from './settings';
import { createWebhookService } from './webhooks';
import { createRemoteClient, type RemoteClient } from './remote';

const port = process.env.PORT ?? 3000;
const logger = createLogger(LOG_LEVEL, LOG_DIRECTORY, LOG_FORMAT);
if (REMOTE_TARGET.error) logger.error(`${REMOTE_TARGET.error}; remote control disabled`);
const db = createDb();
const instanceService = createInstanceService({ db, logger });
const webhookService = createWebhookService({ db });
const settingsService = createSettingsService({ db, applyPresence: instanceService.setOnlinePresence });
const sendService = createSendService({ db, logger });
const chatService = createChatService({ db, downloadMedia: instanceService.downloadMessageMedia });

// Instance changes become queued deliveries; the worker performs the HTTP. The queue is
// the seam: a broker-backed DeliveryQueue drops in here without touching either side.
const deliveryQueue = createDatabaseQueue({ db, logger, concurrency: DELIVERY_CONCURRENCY });
const outbox = createOutbox({ db, queue: deliveryQueue, logger });
outbox.watch(instanceService);
// Inbound messages take the long way round: persist first, then into the same outbox.
createMessageService({ db, outbox, logger }).watch(instanceService);
const deliveryWorker = createDeliveryWorker({ queue: deliveryQueue, db, logger });
deliveryWorker.start();

const pruneCompletedSends = () =>
  sendService.pruneCompleted().catch((err: unknown) => logger.error({ err }, 'failed to prune completed sends'));
void pruneCompletedSends();
const sendPruneTimer = setInterval(pruneCompletedSends, 24 * 60 * 60 * 1000);
sendPruneTimer.unref();

const compactFinishedDeliveries = () =>
  deliveryQueue
    .compactFinished(new Date(Date.now() - DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000))
    .catch((err: unknown) => logger.error({ err }, 'failed to compact finished webhook deliveries'));
void compactFinishedDeliveries();
const deliveryPruneTimer = setInterval(compactFinishedDeliveries, 24 * 60 * 60 * 1000);
deliveryPruneTimer.unref();

let server: import('node:http').Server | undefined;
let remoteClient: RemoteClient | undefined;
let shuttingDown = false;

async function startServer(): Promise<void> {
  const validator = await createControlValidator();
  const controlService = createControlService({ validator, instanceService, webhookService, settingsService, logger });
  if (REMOTE_TARGET.target) remoteClient = createRemoteClient({ target: REMOTE_TARGET.target, logger, control: controlService });
  const app = createApp({ instanceService, webhookService, settingsService, sendService, chatService, logger, controlService });
  if (isDevelopment() && process.env.ENABLE_DEV_MCP === 'true') {
    const { createDevMcpRouter } = await import('./dev-mcp.js');
    app.use('/dev/mcp', createDevMcpRouter({ db, instanceService, chatService, logger }));
    logger.warn('development MCP enabled at /dev/mcp without authentication; it permits arbitrary project_eval code');
  }
  if (ENABLE_MCP_SERVER) {
    const { createMcpRouter } = await import('./mcp/router.js');
    app.use(MCP_PATH, createMcpRouter(
      { instanceService, chatService, sendService, controlService, logger, toolFilter: { readOnly: MCP_READ_ONLY, allow: MCP_TOOLS } },
      { allowedHosts: MCP_ALLOWED_HOSTS },
    ));
    logger.warn({ path: MCP_PATH }, 'MCP server enabled with Bearer auth');
  }

  server = app.listen(port, () => {
    logger.info({ port }, 'server listening');
    if (!shuttingDown) remoteClient?.start();
  });
  webhookService
    .findRejectedTargets()
    .then((rejected) => {
      for (const { instanceName, errors } of rejected) {
        logger.warn({ instance: instanceName, errors }, 'stored webhook target is no longer allowed; its deliveries will fail');
      }
    })
    .catch((err: unknown) => logger.error({ err }, 'failed to check stored webhook targets'));
  instanceService.restoreInstances().catch((err: unknown) => logger.error({ err }, 'failed to restore instances'));
}

void startServer().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});

// A deploy sends SIGTERM and waits. Stop the remote client and the delivery worker together:
// the worker starts no new pass while control operations drain, and a pass already running
// finishes its batch (each attempt bounded by its request timeout) so it is recorded rather
// than re-sent as a duplicate after restart. Then stop the listener and let in-flight requests
// finish. Baileys sockets keep the event loop alive, so exiting is always explicit. SSE never
// ends and would hold close() forever: idle keep-alive sockets drop immediately, everything
// else hits the backstop.
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  clearInterval(sendPruneTimer);
  const forceExit = setTimeout(() => {
    logger.warn('forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await Promise.all([remoteClient?.stop(), deliveryWorker.stop()]);
  if (!server) return process.exit(0);
  const appServer = server;
  // SSE streams never end on their own, so close() would wait for the force-exit.
  // Give ordinary in-flight requests a moment, then tear the streams down.
  const closeStreams = setTimeout(() => appServer.closeAllConnections(), 2000);
  closeStreams.unref();
  appServer.close(() => {
    clearTimeout(closeStreams);
    logger.info('server closed');
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
