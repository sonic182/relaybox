import type { Request, Response } from 'express';
import type { WebhookConfigInput, WebhookConfigResponse } from '../contracts/evolution';
import { toArray } from '../forms';
import { readInstanceName } from './requests';
import { InstanceNotFoundError, WebhookValidationError, type WebhookService } from '../webhooks';
import { EMPTY_WEBHOOK_FORM, webhookForm, webhookPage, type WebhookFormValues } from '../views';

function toFormValues(config: WebhookConfigResponse | null): WebhookFormValues {
  if (!config) return EMPTY_WEBHOOK_FORM;

  return {
    url: config.url,
    enabled: config.enabled,
    byEvents: config.webhookByEvents,
    base64: config.webhookBase64,
    // A disabled config stores no events, but saving it enabled subscribes to
    // everything supported. Show what a save would produce, not the empty row.
    events: config.events.length ? config.events : EMPTY_WEBHOOK_FORM.events,
    headerNames: Object.keys(config.headers ?? {}),
    // The stored secret never round-trips through the browser; an empty field keeps it.
    signatureSecret: '',
    signatureEnabled: config.signatureEnabled,
    hasSignatureSecret: config.hasSignatureSecret,
  };
}

function submittedValues(body: Record<string, unknown>): WebhookFormValues {
  return {
    url: String(body.url ?? ''),
    enabled: body.enabled === 'on',
    byEvents: body.byEvents === 'on',
    base64: body.base64 === 'on',
    events: toArray(body.events),
    headerNames: [],
    signatureSecret: String(body.signatureSecret ?? ''),
    signatureEnabled: body.signatureEnabled === 'on',
    hasSignatureSecret: false,
  };
}

/** HTML adapter for webhook settings; calls the same service as the JSON API. */
export function createWebhooksController(service: WebhookService) {
  async function renderErrors(
    res: Response,
    name: string,
    values: WebhookFormValues,
    errors: string[],
    status = 400,
  ): Promise<void> {
    const stored = await service.getWebhook(name);
    const headerNames = Object.keys(stored?.headers ?? {});
    res.status(status).send(webhookForm(name, { ...values, headerNames }, { errors }));
  }

  async function show(req: Request, res: Response): Promise<void> {
    const name = readInstanceName(req, res);
    if (!name) return;

    // getWebhook answers null for both unknown and unconfigured instances; only a
    // known instance may render a form the user can actually save.
    if (!(await service.instanceExists(name))) {
      res.status(404).send('Instance not found');
      return;
    }

    const [config, deliveries] = await Promise.all([service.getWebhook(name), service.listDeliveries(name)]);
    res.send(webhookPage(name, toFormValues(config), deliveries));
  }

  async function save(req: Request, res: Response): Promise<void> {
    const name = readInstanceName(req, res);
    if (!name) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const values = submittedValues(body);

    // An empty textarea keeps the stored headers, so their values never round-trip
    // through the browser.
    let headers: unknown;
    const raw = String(body.headers ?? '').trim();
    if (raw) {
      try {
        headers = JSON.parse(raw);
      } catch {
        await renderErrors(res, name, values, ['"headers" must be valid JSON']);
        return;
      }
    }

    try {
      const body: WebhookConfigInput = {
        webhook: {
          enabled: values.enabled,
          url: values.url,
          byEvents: values.byEvents,
          base64: values.base64,
          events: values.events as WebhookConfigInput['webhook']['events'],
          ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
          // Empty keeps the stored secret, mirroring the headers textarea.
          ...(values.signatureSecret ? { signatureSecret: values.signatureSecret } : {}),
          signatureEnabled: values.signatureEnabled,
        },
      };
      const config = await service.setWebhook(name, body);

      res.send(webhookForm(name, toFormValues(config), { saved: true }));
    } catch (err) {
      if (err instanceof WebhookValidationError) {
        await renderErrors(res, name, values, err.messages);
        return;
      }
      if (err instanceof InstanceNotFoundError) {
        await renderErrors(res, name, values, [err.message], 404);
        return;
      }
      throw err;
    }
  }

  return { show, save };
}
