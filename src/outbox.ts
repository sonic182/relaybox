import type { Logger } from 'pino';
import { MAX_OUTBOUND_MEDIA_BYTES, SERVER_URL } from './config';
import { buildEnvelope, toEventPath, type EvolutionEvent } from './contracts/evolution';
import type { Db } from './db';
import { toDomainEvents, type DomainEvent } from './events';
import type { InstanceEvent, InstanceService } from './instances';
import type { DeliveryQueue } from './queue';

type OutboxOptions = {
  db: Db;
  queue: DeliveryQueue;
  logger: Logger;
  serverUrl?: string;
};

function withMediaBase64(event: DomainEvent, enabled: boolean): unknown {
  if (
    !enabled ||
    !event.media ||
    event.media.buffer.byteLength > MAX_OUTBOUND_MEDIA_BYTES ||
    (event.event !== 'MESSAGES_UPSERT' && event.event !== 'SEND_MESSAGE')
  ) return event.data;

  const data = event.data as { message?: unknown } | null;
  if (!data?.message || typeof data.message !== 'object' || Array.isArray(data.message)) return event.data;

  return {
    ...data,
    message: { ...(data.message as Record<string, unknown>), base64: event.media.buffer.toString('base64') },
  };
}

/**
 * Turns instance lifecycle events into queued deliveries. Nothing here performs HTTP: the
 * socket callback that triggered the event must never wait on a remote consumer.
 */
export function createOutbox({ db, queue, logger, serverUrl = SERVER_URL }: OutboxOptions) {
  async function enqueue(event: DomainEvent): Promise<boolean> {
    const config = await db.webhookConfig.findUnique({ where: { instanceId: event.instanceId } });
    if (!config?.enabled) return false;

    const selected = (config.events as EvolutionEvent[] | null) ?? [];
    if (!selected.includes(event.event)) return false;

    const payload = buildEnvelope({
      event: event.event,
      instance: event.instanceName,
      data: withMediaBase64(event, config.webhookBase64),
      destination: config.url,
      dateTime: event.occurredAt.toISOString(),
      serverUrl,
      // The reference puts the instance token here. We have no per-instance token
      // yet and API_KEY is also the dashboard credential, so it stays empty rather
      // than handing dashboard access to every webhook consumer.
      apikey: '',
      sender: event.sender,
    });

    return queue.enqueue({
      id: event.id,
      instanceId: event.instanceId,
      event: event.event,
      // Snapshot the target so a later configuration change cannot redirect a
      // delivery that was already queued.
      url: config.webhookByEvents ? `${config.url}/${toEventPath(event.event)}` : config.url,
      payload,
      dedupeKey: event.dedupeKey,
      availableAt: event.occurredAt,
    });
  }

  async function handle(instanceEvent: InstanceEvent): Promise<void> {
    for (const event of toDomainEvents(instanceEvent)) {
      try {
        await enqueue(event);
      } catch (err) {
        logger.error({ err, event: event.event, instance: event.instanceName }, 'failed to enqueue delivery');
      }
    }
  }

  /** Subscribes to instance lifecycle changes; returns the unsubscribe handle. */
  function watch(instanceService: InstanceService): () => void {
    return instanceService.subscribe(handle);
  }

  return { enqueue, handle, watch };
}

export type Outbox = ReturnType<typeof createOutbox>;
