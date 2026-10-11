import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ChatService } from '../../src/chats';
import { createChatsController } from '../../src/controllers/chats';
import type { Instance, InstanceEventListener } from '../../src/instances';
import { createFakeInstanceService, expectSseHeaders } from '../helpers';

const instance: Instance = { id: 'instance-1', name: 'acme', status: 'open' };
const chats: ChatService = {
  listChats: async () => ({ chats: [], cursor: null }),
  listMessages: async () => ({ messages: [], cursor: null }),
  findMessage: async () => null,
  getMedia: async () => null,
};

function createEventStream() {
  const instances = createFakeInstanceService();
  let listener: InstanceEventListener | undefined;
  const unsubscribe = vi.fn();
  vi.mocked(instances.subscribe).mockImplementation((callback) => {
    listener = callback;
    return unsubscribe;
  });
  const req = Object.assign(new EventEmitter(), {
    params: { name: 'acme' },
    query: { jid: 'alex@s.whatsapp.net' },
  });
  const res = { set: vi.fn(), flushHeaders: vi.fn(), write: vi.fn() };
  return { instances, unsubscribe, req, res, emit: (event: Parameters<InstanceEventListener>[0]) => listener?.(event) };
}

describe('chat events', () => {
  it('pushes matching receipt changes and unsubscribes when the stream closes', async () => {
    const { instances, unsubscribe, req, res, emit } = createEventStream();

    createChatsController(chats, instances).events(req as unknown as Request, res as unknown as Response);

    expectSseHeaders(res);

    await emit({
      type: 'message-updated',
      instance,
      update: {
        key: { id: 'MSG-1', remoteJid: 'alex@s.whatsapp.net', fromMe: true },
        status: 'SERVER_ACK',
      },
    });
    await emit({
      type: 'message-updated',
      instance,
      update: {
        key: { id: 'OTHER', remoteJid: 'other@s.whatsapp.net', fromMe: true },
        status: 'DELIVERY_ACK',
      },
    });

    // Both receipts arrive: the filter matches by instance name only, not by jid,
    // because a receipt can be keyed by the LID form while the page jid is the phone form.
    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.write).toHaveBeenNthCalledWith(1, 'event: message-status\ndata: {"keyId":"MSG-1","status":"SERVER_ACK"}\n\n');
    expect(res.write).toHaveBeenNthCalledWith(2, 'event: message-status\ndata: {"keyId":"OTHER","status":"DELIVERY_ACK"}\n\n');

    req.emit('close');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('forwards receipts keyed by a different jid form (LID vs phone)', async () => {
    const { instances, req, res, emit } = createEventStream();

    createChatsController(chats, instances).events(req as unknown as Request, res as unknown as Response);

    // A receipt keyed by the LID form must still reach the SSE stream.
    await emit({
      type: 'message-updated',
      instance,
      update: {
        key: { id: 'MSG-LID', remoteJid: '100000000000002@lid', fromMe: true },
        status: 'READ',
      },
    });

    expect(res.write).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledWith('event: message-status\ndata: {"keyId":"MSG-LID","status":"READ"}\n\n');
  });
});
