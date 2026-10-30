import addFormats from 'ajv-formats';
import OpenAPIBackend, { type Document } from 'openapi-backend';
import type { Logger } from 'pino';
import { badRequest, conflict, notFound } from './error-core';
import { requireApiInstance } from './instances';
import type {
  ConnectResponse, ConnectionStateResponse, InstanceCreateInput, InstanceListItem, InstanceOperationResponse, SettingsInput,
} from '../contracts/evolution';
import { CONNECTION_STATES } from '../events';
import { isValidName, sleep, type Instance, type InstanceService } from '../instances';
import { loadOpenApiDocument } from '../openapi';
import type { SettingsService } from '../settings';
import type { WebhookService } from '../webhooks';

const CONNECT_WAIT_MS = 2000;
const CONTROL_OPERATIONS = new Set([
  'createInstance', 'fetchInstances', 'getConnectionState', 'connectInstance',
  'logoutInstance', 'deleteInstance', 'renameInstance', 'disconnectInstance',
  'setWebhook', 'findWebhook', 'setSettings', 'findSettings',
]);

export type ControlRequest = { method: string; path: string; body?: unknown };
export type ControlResponse = { status: number; body: unknown };
export type ControlService = { execute(request: ControlRequest): Promise<ControlResponse> };

/** Build request validation from the single OpenAPI document before serving requests. */
export async function createControlValidator(): Promise<OpenAPIBackend> {
  const definition = loadOpenApiDocument() as Document;
  const api = new OpenAPIBackend({
    definition,
    strict: true,
    // The library's document checker targets OpenAPI 3.0; request schemas below are still validated.
    quick: true,
    customizeAjv: (ajv) => addFormats(ajv),
  });
  await api.init();
  return api;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Request body must be an object');
  return body as Record<string, unknown>;
}

function createInput(body: unknown): InstanceCreateInput {
  const value = bodyObject(body);
  const unsupported = Object.keys(value).find((key) => !['instanceName', 'qrcode', 'integration', 'webhook', 'syncFullHistory'].includes(key));
  if (unsupported) throw badRequest(`Unsupported field: ${unsupported}`);
  if (!isValidName(value.instanceName)) throw badRequest('Invalid instance name');
  if (value.qrcode !== undefined && typeof value.qrcode !== 'boolean') throw badRequest('"qrcode" must be a boolean');
  if (value.syncFullHistory !== undefined && typeof value.syncFullHistory !== 'boolean') throw badRequest('"syncFullHistory" must be a boolean');
  if (value.integration !== undefined && value.integration !== 'WHATSAPP-BAILEYS') throw badRequest('"integration" must be "WHATSAPP-BAILEYS"');
  if (value.webhook !== undefined && (typeof value.webhook !== 'object' || value.webhook === null || Array.isArray(value.webhook))) {
    throw badRequest('"webhook" must be an object');
  }
  return value as InstanceCreateInput;
}

const SETTINGS_FIELDS = ['syncFullHistory', 'alwaysOnline'] as const;

function settingsInput(body: unknown): SettingsInput {
  const value = bodyObject(body);
  const unsupported = Object.keys(value).find((key) => !(SETTINGS_FIELDS as readonly string[]).includes(key));
  if (unsupported) throw badRequest(`Unsupported field: ${unsupported}`);
  if (!SETTINGS_FIELDS.some((field) => field in value)) throw badRequest(`Expected at least one of: ${SETTINGS_FIELDS.join(', ')}`);
  const input: SettingsInput = {};
  for (const field of SETTINGS_FIELDS) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'boolean') throw badRequest(`"${field}" must be a boolean`);
    input[field] = value[field];
  }
  return input;
}

function renameInput(body: unknown): string {
  const value = bodyObject(body);
  if (Object.keys(value).some((key) => key !== 'newName')) throw badRequest('Unsupported field');
  if (!isValidName(value.newName)) throw badRequest('Invalid instance name');
  return value.newName;
}

/**
 * Origin-form path of an HTTP request target: an absolute-form target drops its scheme and authority.
 * The path is kept verbatim, so `execute` sees any dot segment Express routed around.
 */
export function controlPath(originalUrl: string): string {
  return originalUrl.replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, '');
}

/** Webhook persistence trims the secret; validate the same value without changing the request. */
function normalizedWebhookBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const value = body as Record<string, unknown>;
  const webhook = value.webhook;
  if (typeof webhook !== 'object' || webhook === null || Array.isArray(webhook)) return body;
  const fields = webhook as Record<string, unknown>;
  return {
    ...value,
    webhook: {
      ...fields,
      ...(typeof fields.signatureSecret === 'string' ? { signatureSecret: fields.signatureSecret.trim() } : {}),
    },
  };
}

function operationResponse(instance: Instance): InstanceOperationResponse {
  return { instance: { instanceName: instance.name, instanceId: instance.id, integration: 'WHATSAPP-BAILEYS', status: CONNECTION_STATES[instance.status] } };
}

function listItem(instance: Instance): InstanceListItem {
  return { id: instance.id, name: instance.name, connectionStatus: CONNECTION_STATES[instance.status], ...(instance.user ? { ownerJid: instance.user } : {}) };
}

/** Evolution control operations shared by authenticated HTTP requests and the outbound socket. */
export function createControlService({ validator: api, instanceService, webhookService, settingsService, logger }: {
  validator: OpenAPIBackend;
  instanceService: InstanceService; webhookService: WebhookService; settingsService: SettingsService; logger: Logger;
}): ControlService {
  return {
    async execute({ method, path, body }) {
      let url: URL;
      try {
        url = new URL(path, 'http://localhost');
        if (url.origin !== 'http://localhost' || !path.startsWith('/')) throw new Error('Invalid path');
        // `new URL` resolves dot segments (including `%2e%2e`) and backslashes; matching the rewritten
        // path would run a different operation than the one the caller named.
        if (url.pathname !== path.split(/[?#]/, 1)[0]) throw new Error('Invalid path');
      } catch {
        throw badRequest('Invalid request path');
      }
      const apiRequest = { method: method.toUpperCase(), path: url.pathname + url.search, headers: { 'content-type': 'application/json' }, body };
      const operation = api.matchOperation(apiRequest);
      if (!operation?.operationId || !CONTROL_OPERATIONS.has(operation.operationId)) throw notFound(`Cannot ${method.toUpperCase()} ${path}`);
      let params: Record<string, string>;
      try {
        params = api.router.parseRequest(apiRequest, operation).params as Record<string, string>;
      } catch (error) {
        if (error instanceof URIError) throw badRequest('Invalid request path');
        throw error;
      }
      const name = params.instanceName;
      const query = url.searchParams;
      if (name !== undefined && !isValidName(name)) throw badRequest('Invalid instance name');

      // Preserve domain-specific checks and reference error messages before schema validation.
      let input: InstanceCreateInput | undefined;
      let newName: string | undefined;
      let settings: SettingsInput | undefined;
      if (operation.operationId === 'setSettings') settings = settingsInput(body);
      if (operation.operationId === 'createInstance') {
        input = createInput(body);
        if (input.webhook) webhookService.validateWebhook({ webhook: input.webhook });
      }
      if (operation.operationId === 'renameInstance') newName = renameInput(body);
      if (operation.operationId === 'setWebhook') {
        webhookService.validateWebhook(body, { allowStoredSecret: true });
      }
      if (operation.operationId === 'fetchInstances') {
        const unsupported = [...query.keys()].find((key) => !['instanceName', 'instanceId'].includes(key));
        if (unsupported) throw badRequest(`Unsupported query parameter: ${unsupported}`);
        if ([...query.keys()].some((key) => query.getAll(key).length > 1)) throw badRequest('Query parameters must be singular');
        const instanceName = query.get('instanceName');
        if (instanceName !== null && !isValidName(instanceName)) throw badRequest('Invalid instance name');
      }
      const validation = api.validateRequest({ ...apiRequest, body: normalizedWebhookBody(body) }, operation);
      if (!validation.valid) {
        throw badRequest(validation.errors?.map((error) => `${error.instancePath || error.schemaPath}: ${error.message}`) ?? 'Invalid request');
      }

      switch (operation.operationId) {
        case 'createInstance': {
          const value = input!;
          if (instanceService.getInstance(value.instanceName)) throw conflict(`This name "${value.instanceName}" is already in use.`);
          let instance = await instanceService.createInstance(value.instanceName, { failIfExists: true });
          try {
            if (value.webhook) await webhookService.setWebhook(value.instanceName, { webhook: value.webhook });
            if (value.syncFullHistory !== undefined) await settingsService.setSettings(value.instanceName, { syncFullHistory: value.syncFullHistory });
          } catch (error) {
            await instanceService.deleteInstance(value.instanceName).catch((cleanupError: unknown) =>
              logger.error({ err: cleanupError, instance: value.instanceName }, 'failed to clean up instance after setup failed'));
            throw error;
          }
          if (value.qrcode) {
            await sleep(CONNECT_WAIT_MS);
            instance = instanceService.getInstance(value.instanceName) ?? instance;
          }
          const result = operationResponse(instance);
          if (value.qrcode && instance.qrDataUrl) result.qrcode = { base64: instance.qrDataUrl, ...(instance.qr ? { code: instance.qr } : {}) };
          return { status: 201, body: result };
        }
        case 'fetchInstances': {
          const instanceName = query.get('instanceName');
          const instanceId = query.get('instanceId');
          const instances = instanceService.listInstances().filter((instance) =>
            (instanceName === null || instance.name === instanceName) && (instanceId === null || instance.id === instanceId));
          if ((instanceName !== null || instanceId !== null) && instances.length === 0) {
            throw notFound(`The "${instanceName ?? instanceId}" instance does not exist`);
          }
          return { status: 200, body: instances.map(listItem) };
        }
        case 'getConnectionState': {
          const instance = requireApiInstance(instanceService, name);
          const result: ConnectionStateResponse = { instance: { instanceName: instance.name, state: CONNECTION_STATES[instance.status] } };
          return { status: 200, body: result };
        }
        case 'connectInstance': {
          requireApiInstance(instanceService, name);
          if (instanceService.getInstance(name)?.status === 'close') {
            await instanceService.reconnectInstance(name);
            await sleep(CONNECT_WAIT_MS);
          }
          const instance = requireApiInstance(instanceService, name);
          const result: ConnectResponse = instance.status === 'open'
            ? { instance: { instanceName: instance.name, state: 'open' } }
            : instance.qrDataUrl ? { base64: instance.qrDataUrl }
              : { instance: { instanceName: instance.name, state: CONNECTION_STATES[instance.status] } };
          return { status: 200, body: result };
        }
        case 'logoutInstance':
          requireApiInstance(instanceService, name);
          await instanceService.logoutInstance(name);
          return { status: 200, body: {} };
        case 'deleteInstance':
          requireApiInstance(instanceService, name);
          await instanceService.deleteInstance(name);
          return { status: 200, body: { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } } };
        case 'renameInstance':
          requireApiInstance(instanceService, name);
          if (newName !== name && instanceService.getInstance(newName!)) throw conflict(`This name "${newName}" is already in use.`);
          await instanceService.renameInstance(name, newName!);
          return { status: 200, body: operationResponse(requireApiInstance(instanceService, newName!)) };
        case 'disconnectInstance':
          requireApiInstance(instanceService, name);
          await instanceService.disconnectInstance(name);
          return { status: 200, body: operationResponse(requireApiInstance(instanceService, name)) };
        case 'setWebhook':
          return { status: 201, body: await webhookService.setWebhook(name, body) };
        case 'findWebhook':
          return { status: 200, body: await webhookService.getWebhook(name) };
        case 'setSettings':
          return { status: 201, body: { settings: { instanceName: name, settings: await settingsService.setSettings(name, settings!) } } };
        case 'findSettings':
          return { status: 200, body: await settingsService.getSettings(name) };
      }
      throw notFound(`Cannot ${method.toUpperCase()} ${path}`);
    },
  };
}
