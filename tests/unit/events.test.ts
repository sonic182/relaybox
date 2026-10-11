import { describe, expect, it } from 'vitest';
import { toDomainEvents, toMessageDeleteEvent, toMessageEditedEvent, toMessageUpdateEvent } from '../../src/events';
import type { Instance } from '../../src/instances';

const instance: Instance = { id: 'inst-1', name: 'acme', status: 'open', user: '5511999999999@s.whatsapp.net' };

describe('toDomainEvents', () => {
  it('ignores deletions', () => {
    expect(toDomainEvents({ type: 'deleted', name: 'acme' })).toEqual([]);
  });

  it('maps a send to SEND_MESSAGE, carrying the same payload as an upsert', () => {
    const message = {
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
      message: { conversation: 'hola' },
      messageType: 'conversation',
      messageTimestamp: 1756555200,
      instanceId: instance.id,
      status: 'PENDING',
    };

    const [event] = toDomainEvents({ type: 'sent', instance, message });

    expect(event.event).toBe('SEND_MESSAGE');
    expect(event.data).toMatchObject({
      key: message.key,
      message: { conversation: 'hola' },
      messageType: 'conversation',
      instanceId: 'inst-1',
      status: 'PENDING',
    });
    // The event name is part of the key, so the upsert echo of this same message
    // still enqueues its own MESSAGES_UPSERT delivery.
    expect(event.dedupeKey).toBe('SEND_MESSAGE:inst-1:5511888888888@s.whatsapp.net:true:SENT-1');
  });

  // Without a guard these fall through to the connection branch and fire a webhook that
  // nothing actually happened for.
  it('publishes nothing for a group name', () => {
    expect(toDomainEvents({ type: 'groups', instance, groups: [{ id: '1-2@g.us', subject: 'Quinta' }] })).toEqual(
      [],
    );
  });

  it('publishes nothing for imported history', () => {
    expect(toDomainEvents({ type: 'history', instance, messages: [], contacts: [] })).toEqual([]);
  });

  it('maps a qr update to QRCODE_UPDATED', () => {
    const [event] = toDomainEvents({
      type: 'updated',
      change: 'qr',
      instance: { ...instance, status: 'qr', qr: '2@abcdef', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    });

    expect(event.event).toBe('QRCODE_UPDATED');
    expect(event.data).toEqual({
      qrcode: { instance: 'acme', pairingCode: null, code: '2@abcdef', base64: 'data:image/png;base64,iVBORw0KGgo=' },
    });
    // The same QR must not enqueue twice.
    expect(event.dedupeKey).toBe('QRCODE_UPDATED:inst-1:2@abcdef');
  });

  it('drops a qr change that carries no code', () => {
    expect(toDomainEvents({ type: 'updated', change: 'qr', instance })).toEqual([]);
  });

  it('maps a connection change to CONNECTION_UPDATE', () => {
    const [event] = toDomainEvents({ type: 'updated', change: 'connection', instance });

    expect(event.event).toBe('CONNECTION_UPDATE');
    expect(event.data).toEqual({ instance: 'acme', state: 'open', wuid: '5511999999999@s.whatsapp.net' });
    expect(event.sender).toBe('5511999999999@s.whatsapp.net');
    expect(event.dedupeKey).toBe(`CONNECTION_UPDATE:inst-1:${event.id}`);
  });

  it('reports the qr step as the connecting state the reference uses', () => {
    const [event] = toDomainEvents({
      type: 'updated',
      change: 'connection',
      instance: { ...instance, status: 'qr', user: undefined },
    });

    expect(event.data).toEqual({ instance: 'acme', state: 'connecting' });
    expect(event.sender).toBeUndefined();
  });

  it('treats a created instance as a connection update', () => {
    const [event] = toDomainEvents({ type: 'created', instance: { ...instance, status: 'connecting' } });

    expect(event.event).toBe('CONNECTION_UPDATE');
    expect(event.data).toMatchObject({ state: 'connecting' });
  });

  it('maps an outbound edit to SEND_MESSAGE_UPDATE', () => {
    const [event] = toDomainEvents({
      type: 'sent-message-update',
      instance,
      message: {
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
        data: { key: { id: 'SENT-1' }, editedMessage: { conversation: 'corregido' }, type: 'MESSAGE_EDIT' },
        message: { conversation: 'corregido' },
        messageType: 'conversation',
        messageTimestamp: 1756555300,
      },
    });

    expect(event.event).toBe('SEND_MESSAGE_UPDATE');
    expect(event.data).toEqual({ key: { id: 'SENT-1' }, editedMessage: { conversation: 'corregido' }, type: 'MESSAGE_EDIT' });
  });

  it('maps an inbound edit after persistence, not from the lifecycle outbox', () => {
    const message = {
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'SENT-1' },
      data: { key: { id: 'SENT-1' }, editedMessage: { conversation: 'corregido' }, type: 'MESSAGE_EDIT' },
      message: { conversation: 'corregido' },
      messageType: 'conversation',
      messageTimestamp: 1756555300,
    };

    expect(toDomainEvents({ type: 'message-edited', instance, message })).toEqual([]);
    expect(toMessageEditedEvent(instance, message)).toMatchObject({
      event: 'MESSAGES_EDITED',
      data: message.data,
    });
  });

  it('maps a status update after persistence, not from the lifecycle outbox', () => {
    const update = {
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'UPDATE-1' },
      status: 'READ',
    };

    expect(toDomainEvents({ type: 'message-updated', instance, update })).toEqual([]);
    expect(toMessageUpdateEvent(instance, update)).toMatchObject({
      event: 'MESSAGES_UPDATE',
      data: {
        keyId: 'UPDATE-1',
        remoteJid: '5511888888888@s.whatsapp.net',
        fromMe: true,
        status: 'READ',
        instanceId: 'inst-1',
      },
      dedupeKey: 'MESSAGES_UPDATE:inst-1:5511888888888@s.whatsapp.net:true:UPDATE-1:READ',
    });
  });

  it('maps a revoke to the reference key-only payload', () => {
    const key = { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'DELETE-1' };

    expect(toMessageDeleteEvent(instance, key)).toMatchObject({
      event: 'MESSAGES_DELETE',
      data: { ...key, status: 'DELETED' },
      dedupeKey: 'MESSAGES_DELETE:inst-1:5511888888888@s.whatsapp.net:false:DELETE-1',
    });
  });
});
