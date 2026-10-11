import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createInstancesController } from '../../src/controllers/instances';
import { dashboardPage } from '../../src/views';
import type { Instance, InstanceEventListener, InstanceService } from '../../src/instances';
import { expectSseHeaders } from '../helpers';

const instance: Instance = { id: 'instance-1', name: 'acme', status: 'open' };

describe('instance events', () => {
  it('writes an instance fragment and unsubscribes when the stream closes', async () => {
    let listener: InstanceEventListener | undefined;
    const unsubscribe = vi.fn();
    const service: InstanceService = {
      listInstances: () => [instance],
      getInstance: () => instance,
      createInstance: async () => instance,
      renameInstance: async () => {},
      sendText: async () => {
        throw new Error('not used by the event stream');
      },
      sendMedia: async () => {
        throw new Error('not used by the event stream');
      },
      sendAudio: async () => {
        throw new Error('not used by the event stream');
      },
      downloadMessageMedia: async () => undefined,
      getProfilePictureUrl: async () => undefined,
      getBusinessProfile: async () => undefined,
      editMessage: async () => {
        throw new Error('not used by the event stream');
      },
      disconnectInstance: async () => {},
      logoutInstance: async () => {},
      reconnectInstance: async () => {},
      deleteInstance: async () => {},
      restoreInstances: async () => {},
      subscribe: (callback) => {
        listener = callback;
        return unsubscribe;
      },
    };
    const req = new EventEmitter();
    const res = {
      set: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
    };

    createInstancesController(service, { execute: vi.fn() }).events(req as unknown as Request, res as unknown as Response);

    expectSseHeaders(res);

    const fragment = (call: number) => {
      const [message] = res.write.mock.calls[call] as [string];
      expect(message).toMatch(/^event: instances\ndata: /);
      return JSON.parse(message.slice('event: instances\ndata: '.length, -2)) as string;
    };

    // A snapshot goes out before any event, so a stream that opened (or reconnected)
    // after a transition is not left showing stale instances.
    expect(res.write).toHaveBeenCalledOnce();
    expect(fragment(0)).toContain('acme');

    await listener?.({ type: 'updated', instance, change: 'connection' });

    expect(res.write).toHaveBeenCalledTimes(2);
    expect(fragment(1)).toContain('acme');

    req.emit('close');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  // The stream writes a JSON-encoded fragment, so the page script must decode it.
  // Assigning the raw data line to innerHTML renders the quotes and loses every class.
  it('is decoded by the dashboard page script', () => {
    expect(dashboardPage([instance])).toContain('JSON.parse(event.data)');
  });
});
