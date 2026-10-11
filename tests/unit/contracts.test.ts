import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_EVENTS,
  WEBHOOK_EVENTS,
  apiErrorBody,
  buildEnvelope,
  isSupportedEvent,
  toEventName,
  toEventPath,
  type EvolutionEvent,
} from '../../src/contracts/evolution';
import connectionUpdate from '../fixtures/evolution/envelope.connection-update.json';
import messagesDelete from '../fixtures/evolution/envelope.messages-delete.json';
import messagesEdited from '../fixtures/evolution/envelope.messages-edited.json';
import messagesUpdate from '../fixtures/evolution/envelope.messages-update.json';
import sendMessage from '../fixtures/evolution/envelope.send-message.json';
import sendMessageUpdate from '../fixtures/evolution/envelope.send-message-update.json';
import messagesUpsert from '../fixtures/evolution/envelope.messages-upsert.json';
import qrcodeUpdated from '../fixtures/evolution/envelope.qrcode-updated.json';
import notFound from '../fixtures/evolution/error.not-found.json';
import unauthorized from '../fixtures/evolution/error.unauthorized.json';
import setRequest from '../fixtures/evolution/webhook-set.request.json';
import setInvalid from '../fixtures/evolution/webhook-set.invalid.json';

const fixtures: [EvolutionEvent, Record<string, unknown>][] = [
  ['QRCODE_UPDATED', qrcodeUpdated],
  ['CONNECTION_UPDATE', connectionUpdate],
  ['MESSAGES_UPSERT', messagesUpsert],
  ['MESSAGES_EDITED', messagesEdited],
  ['MESSAGES_UPDATE', messagesUpdate],
  ['MESSAGES_DELETE', messagesDelete],
  ['SEND_MESSAGE', sendMessage],
  ['SEND_MESSAGE_UPDATE', sendMessageUpdate],
];

describe('event names', () => {
  it('delivers lowercase dotted names', () => {
    expect(SUPPORTED_EVENTS.map(toEventName)).toEqual([
      'qrcode.updated',
      'connection.update',
      'messages.upsert',
      'messages.edited',
      'messages.update',
      'messages.delete',
      'send.message',
      'send.message.update',
    ]);
  });

  it('builds kebab-case byEvents suffixes', () => {
    expect(toEventPath('MESSAGES_UPSERT')).toBe('messages-upsert');
    expect(toEventPath('SEND_MESSAGE')).toBe('send-message');
    expect(toEventPath('STATUS_UPDATE')).toBe('status-update');
  });

  it('accepts the reference subset plus explicit extensions', () => {
    expect(setRequest.webhook.events.every(isSupportedEvent)).toBe(true);
    expect(setInvalid.webhook.events.filter((event) => !isSupportedEvent(event))).toEqual(['CHATWOOT_IMPORT']);
    expect(SUPPORTED_EVENTS).not.toContain('STATUS_UPDATE');
    expect(WEBHOOK_EVENTS).toContain('STATUS_UPDATE');
    expect(toEventName('STATUS_UPDATE')).toBe('status.update');
  });
});

describe('buildEnvelope', () => {
  it.each(fixtures)('reproduces the %s fixture', (event, fixture) => {
    const envelope = buildEnvelope({
      event,
      instance: fixture.instance as string,
      data: fixture.data,
      destination: fixture.destination as string,
      dateTime: fixture.date_time as string,
      sender: fixture.sender as string,
      serverUrl: fixture.server_url as string,
      apikey: fixture.apikey as string,
    });

    expect(envelope).toEqual(fixture);
    // The reference emits a fixed key order; consumers pinning it must not break.
    expect(Object.keys(envelope)).toEqual(Object.keys(fixture));
  });

  it('places event-specific extras before the fixed keys', () => {
    const envelope = buildEnvelope({
      event: 'MESSAGES_UPSERT',
      instance: 'acme',
      data: {},
      destination: 'https://consumer.example/hook',
      dateTime: '2026-08-30T12:00:00.000Z',
      serverUrl: 'http://localhost:3000',
      apikey: 'test-api-key-0000',
      extra: { chatwootConversationId: 7 },
    });

    expect(Object.keys(envelope)[0]).toBe('chatwootConversationId');
    expect(envelope.event).toBe('messages.upsert');
  });
});

describe('apiErrorBody', () => {
  it('matches the reference error envelope', () => {
    expect(apiErrorBody(401, 'Unauthorized', 'Unauthorized')).toEqual(unauthorized);
    expect(apiErrorBody(404, 'Not Found', ['Cannot GET /webhook/find/missing'])).toEqual(notFound);
  });
});
