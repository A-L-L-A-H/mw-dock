import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { DockEventBus, dockRealtimeRoutes } from '../src/dock-realtime.js';

const PUBLISH_URL = '/api/v1/dock/realtime/publish';
const VALID_BODY = {
  model: 'dock.contract_sample',
  action: 'create',
  recordId: 41,
  payload: { source: 'contract-test' },
};

describe('Dock realtime publish token negative contract', () => {
  let app: FastifyInstance | null = null;
  let originalRealtimeToken: string | undefined;

  afterEach(async () => {
    if (originalRealtimeToken === undefined) {
      delete process.env.DOCK_REALTIME_TOKEN;
    } else {
      process.env.DOCK_REALTIME_TOKEN = originalRealtimeToken;
    }
    originalRealtimeToken = undefined;
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('rejects publish without DOCK_REALTIME_TOKEN header', async () => {
    const bus = new DockEventBus();
    const published = vi.fn();
    bus.subscribe(published);
    app = Fastify();
    await app.register(dockRealtimeRoutes, {
      bus,
      addons: [],
      heartbeatMs: 0,
      publishToken: 'expected-realtime-token',
    });

    const response = await app.inject({
      method: 'POST',
      url: PUBLISH_URL,
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      success: false,
      error: 'Authentication required',
      code: 'UNAUTHORIZED',
    });
    expect(published).not.toHaveBeenCalled();
  });

  it('rejects publish with an invalid DOCK_REALTIME_TOKEN header value', async () => {
    const bus = new DockEventBus();
    const published = vi.fn();
    bus.subscribe(published);
    app = Fastify();
    await app.register(dockRealtimeRoutes, {
      bus,
      addons: [],
      heartbeatMs: 0,
      publishToken: 'expected-realtime-token',
    });

    const response = await app.inject({
      method: 'POST',
      url: PUBLISH_URL,
      headers: { 'x-dock-realtime-token': 'not-the-expected-token' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      success: false,
      error: 'Authentication required',
      code: 'UNAUTHORIZED',
    });
    expect(published).not.toHaveBeenCalled();
  });

  it('rejects publish with an empty DOCK_REALTIME_TOKEN header value', async () => {
    const bus = new DockEventBus();
    const published = vi.fn();
    bus.subscribe(published);
    app = Fastify();
    await app.register(dockRealtimeRoutes, {
      bus,
      addons: [],
      heartbeatMs: 0,
      publishToken: 'expected-realtime-token',
    });

    const response = await app.inject({
      method: 'POST',
      url: PUBLISH_URL,
      headers: { 'x-dock-realtime-token': '' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(published).not.toHaveBeenCalled();
  });

  it('accepts publish only with the exact DOCK_REALTIME_TOKEN header value', async () => {
    const bus = new DockEventBus();
    const published = vi.fn();
    bus.subscribe(published);
    app = Fastify();
    await app.register(dockRealtimeRoutes, {
      bus,
      addons: [],
      heartbeatMs: 0,
      publishToken: 'expected-realtime-token',
    });

    const response = await app.inject({
      method: 'POST',
      url: PUBLISH_URL,
      headers: { 'x-dock-realtime-token': 'expected-realtime-token' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ok: true });
    expect(published).toHaveBeenCalledTimes(1);
  });

  it('allows publish when requireAuthForPublish is false and no token is configured', async () => {
    originalRealtimeToken = process.env.DOCK_REALTIME_TOKEN;
    process.env.DOCK_REALTIME_TOKEN = '';
    const bus = new DockEventBus();
    const published = vi.fn();
    bus.subscribe(published);
    app = Fastify();
    await app.register(dockRealtimeRoutes, {
      bus,
      addons: [],
      heartbeatMs: 0,
      requireAuthForPublish: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: PUBLISH_URL,
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(202);
    expect(published).toHaveBeenCalledTimes(1);
  });
});
