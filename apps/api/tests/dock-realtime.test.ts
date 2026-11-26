import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { defineModel, fields, Registry } from '@moonwitness/orm';
import {
  fetchDockSchema,
  subscribeDockRealtime,
  type DockRealtimeEvent as ClientDockRealtimeEvent,
} from '@moonwitness/client';
import {
  DockEventBus,
  dockRealtimeRoutes,
  type DockRealtimeEvent,
} from '../src/dock-realtime.js';

const DockRealtimeSampleModel = defineModel('dock.realtime_sample', {
  table: 'dock_realtime_samples',
  fields: {
    title: fields.string({ required: true }),
    published: fields.boolean({ default: true }),
  },
});

if (!Registry.has('dock.realtime_sample')) {
  Registry.register(DockRealtimeSampleModel);
}

describe('DockEventBus', () => {
  it('publishes structured events and respects model filters and unsubscribe', () => {
    const bus = new DockEventBus();
    const allEvents: DockRealtimeEvent[] = [];
    const filteredEvents: DockRealtimeEvent[] = [];

    const unsubAll = bus.subscribe((event) => allEvents.push(event));
    const unsubFiltered = bus.subscribe((event) => filteredEvents.push(event), {
      model: 'dock.realtime_sample',
    });

    expect(bus.subscriberCount).toBe(2);

    const first = bus.publish({
      model: 'dock.realtime_sample',
      action: 'create',
      recordId: 42,
      payload: { title: 'Hello' },
    });
    const second = bus.publish({
      model: 'base.partner',
      action: 'write',
      recordId: 7,
      payload: { name: 'Other' },
    });

    expect(first.id).toBeTruthy();
    expect(first.ts).toBeTruthy();
    expect(allEvents).toHaveLength(2);
    expect(filteredEvents).toHaveLength(1);
    expect(filteredEvents[0]).toEqual(first);
    expect(allEvents[1]).toEqual(second);

    unsubFiltered();
    expect(bus.subscriberCount).toBe(1);

    bus.publish({
      model: 'dock.realtime_sample',
      action: 'unlink',
      recordId: 42,
    });
    expect(allEvents).toHaveLength(3);
    expect(filteredEvents).toHaveLength(1);

    unsubAll();
    expect(bus.subscriberCount).toBe(0);
  });
});

describe('Dock Studio Schema & Realtime SSE HTTP routes', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('introspects active ORM registry via GET /api/v1/dock/studio/schema and client helper', async () => {
    const bus = new DockEventBus();
    app = Fastify();
    await app.register(dockRealtimeRoutes, {
      bus,
      addons: ['base', 'dock-studio'],
      heartbeatMs: 0,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const schema = await fetchDockSchema(address);
    expect(schema.addons).toEqual(['base', 'dock-studio']);
    expect(schema.modelCount).toBeGreaterThan(0);
    expect(schema.modelCount).toBe(schema.models.length);

    const sample = schema.models.find((model) => model.name === 'dock.realtime_sample');
    expect(sample).toBeDefined();
    expect(sample?.label).toBeTruthy();
    expect(sample?.fieldCount).toBeGreaterThanOrEqual(2);
    expect(sample?.fields.some((field) => field.name === 'title')).toBe(true);
    expect(sample?.fields.some((field) => field.name === 'published')).toBe(true);
  });

  it('streams connected, heartbeat, and filtered change events over SSE', async () => {
    const bus = new DockEventBus();
    app = Fastify();
    await app.register(dockRealtimeRoutes, {
      bus,
      addons: ['base'],
      heartbeatMs: 80,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const received: ClientDockRealtimeEvent[] = [];
    let connectedInfo: { id: string; model: string | null; ts: string } | null = null;
    let heartbeatCount = 0;

    let subscription: ReturnType<typeof subscribeDockRealtime> | null = null;
    try {
      const connectedPromise = new Promise<void>((resolve) => {
        subscription = subscribeDockRealtime(
          address,
          (event) => {
            received.push(event);
          },
          {
            model: 'dock.realtime_sample',
            onConnected: (info) => {
              connectedInfo = info;
              resolve();
            },
            onHeartbeat: () => {
              heartbeatCount += 1;
            },
          }
        );
      });

      await connectedPromise;
      expect(connectedInfo).not.toBeNull();
      expect(connectedInfo?.model).toBe('dock.realtime_sample');

      const ignoredResp = await fetch(`${address}/api/v1/dock/realtime/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'base.partner',
          action: 'create',
          recordId: 99,
          payload: { name: 'Filtered Out' },
        }),
      });
      expect(ignoredResp.status).toBe(202);

      const matchResp = await fetch(`${address}/api/v1/dock/realtime/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'dock.realtime_sample',
          action: 'write',
          recordId: 123,
          payload: { title: 'Updated' },
        }),
      });
      expect(matchResp.status).toBe(202);
      const publishedBody = (await matchResp.json()) as { ok: boolean; event: DockRealtimeEvent };
      expect(publishedBody.ok).toBe(true);
      expect(publishedBody.event.model).toBe('dock.realtime_sample');

      const deadline = Date.now() + 3000;
      while ((received.length === 0 || heartbeatCount === 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(heartbeatCount).toBeGreaterThanOrEqual(1);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        id: publishedBody.event.id,
        model: 'dock.realtime_sample',
        action: 'write',
        recordId: 123,
        payload: { title: 'Updated' },
      });
    } finally {
      subscription?.close();
    }
  });
});
