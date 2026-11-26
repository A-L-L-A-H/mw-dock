import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { describeFields, Registry, type FieldMeta } from '@moonwitness/orm';
import { API_ADDONS } from './addons/registry.js';

export interface DockRealtimeEvent {
  readonly id: string;
  readonly model: string;
  readonly action: string;
  readonly recordId: string | number | null;
  readonly payload: Record<string, unknown>;
  readonly ts: string;
}

export interface DockPublishInput {
  readonly id?: string;
  readonly model: string;
  readonly action: string;
  readonly recordId?: string | number | null;
  readonly payload?: Record<string, unknown>;
  readonly ts?: string;
}

export type DockEventListener = (event: DockRealtimeEvent) => void;

export interface DockSubscribeOptions {
  readonly model?: string;
}

interface DockSubscriber {
  readonly listener: DockEventListener;
  readonly model?: string;
}

export class DockEventBus {
  private readonly subscribers = new Set<DockSubscriber>();

  public publish(input: DockPublishInput): DockRealtimeEvent {
    const event: DockRealtimeEvent = {
      id: input.id ?? randomUUID(),
      model: input.model,
      action: input.action,
      recordId: input.recordId ?? null,
      payload: input.payload ?? {},
      ts: input.ts ?? new Date().toISOString(),
    };

    for (const subscriber of this.subscribers) {
      if (subscriber.model && subscriber.model !== event.model) {
        continue;
      }
      try {
        subscriber.listener(event);
      } catch {
        // Isolate subscriber failures so other listeners continue receiving events.
      }
    }

    return event;
  }

  public subscribe(listener: DockEventListener, options: DockSubscribeOptions = {}): () => void {
    const subscriber: DockSubscriber = {
      listener,
      model: options.model?.trim() || undefined,
    };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  public get subscriberCount(): number {
    return this.subscribers.size;
  }

  public clear(): void {
    this.subscribers.clear();
  }
}

export const dockEventBus = new DockEventBus();

export interface DockStudioSchemaModel {
  readonly name: string;
  readonly label: string;
  readonly fieldCount: number;
  readonly fields: FieldMeta[];
}

export interface DockStudioSchemaResponse {
  readonly addons: string[];
  readonly modelCount: number;
  readonly models: DockStudioSchemaModel[];
}

export interface DockRealtimePluginOptions {
  readonly bus?: DockEventBus;
  readonly addons?: readonly string[];
  readonly heartbeatMs?: number;
  readonly publishToken?: string;
  readonly requireAuthForPublish?: boolean;
}

function formatModelLabel(modelName: string, modelClass: unknown): string {
  if (typeof modelClass === 'function' || (typeof modelClass === 'object' && modelClass !== null)) {
    const candidate = modelClass as { description?: unknown; label?: unknown };
    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      return candidate.label.trim();
    }
    if (typeof candidate.description === 'string' && candidate.description.trim().length > 0) {
      return candidate.description.trim();
    }
  }

  return modelName
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function introspectDockStudioSchema(
  addons: readonly string[] = API_ADDONS.map((addon) => addon.name)
): DockStudioSchemaResponse {
  const models: DockStudioSchemaModel[] = Array.from(Registry.getAll().entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, modelClass]) => {
      const fields = describeFields(modelClass);
      return {
        name,
        label: formatModelLabel(name, modelClass),
        fieldCount: fields.length,
        fields,
      };
    });

  return {
    addons: [...addons],
    modelCount: models.length,
    models,
  };
}

function writeSseFrame(
  write: (chunk: string) => void,
  eventName: string,
  data: unknown,
  id?: string
): void {
  const lines: string[] = [];
  if (id) {
    lines.push(`id: ${id}`);
  }
  lines.push(`event: ${eventName}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  write(`${lines.join('\n')}\n\n`);
}

export const dockRealtimeRoutes: FastifyPluginAsync<DockRealtimePluginOptions> = async (
  fastify,
  options
) => {
  const bus = options.bus ?? dockEventBus;
  const addons = options.addons ?? API_ADDONS.map((addon) => addon.name);
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const publishToken = options.publishToken ?? process.env.DOCK_REALTIME_TOKEN;
  const requireAuthForPublish = options.requireAuthForPublish ?? false;
  const activeStreams = new Set<() => void>();

  fastify.addHook('onClose', async () => {
    for (const closeStream of activeStreams) {
      closeStream();
    }
    activeStreams.clear();
  });

  fastify.get(
    '/api/v1/dock/studio/schema',
    {
      schema: {
        tags: ['System'],
        summary: 'Introspect active ORM registry models, fields, and loaded addons for Dock Studio',
      },
    },
    async () => introspectDockStudioSchema(addons)
  );

  fastify.get<{ Querystring: { model?: string } }>(
    '/api/v1/dock/realtime',
    {
      schema: {
        tags: ['System'],
        summary: 'Stream Dock realtime change events over Server-Sent Events (SSE)',
      },
    },
    async (req, reply) => {
      const modelFilter = req.query.model?.trim() || undefined;
      const connectionId = randomUUID();

      reply.hijack();
      const raw = reply.raw;
      const origin = req.headers.origin;
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
      }

      raw.writeHead(200, headers);
      raw.flushHeaders?.();

      const safeWrite = (chunk: string) => {
        if (!raw.writableEnded && !raw.destroyed) {
          raw.write(chunk);
        }
      };

      writeSseFrame(safeWrite, 'connected', {
        id: connectionId,
        model: modelFilter ?? null,
        ts: new Date().toISOString(),
      });

      const unsubscribe = bus.subscribe(
        (event) => {
          writeSseFrame(safeWrite, 'change', event, event.id);
        },
        { model: modelFilter }
      );

      const heartbeatTimer =
        heartbeatMs > 0
          ? setInterval(() => {
              writeSseFrame(safeWrite, 'heartbeat', {
                id: connectionId,
                ts: new Date().toISOString(),
              });
            }, heartbeatMs)
          : null;
      heartbeatTimer?.unref?.();

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        unsubscribe();
        activeStreams.delete(cleanup);
        if (!raw.writableEnded && !raw.destroyed) {
          raw.end();
        }
      };

      activeStreams.add(cleanup);
      req.raw.once('close', cleanup);
      req.raw.once('aborted', cleanup);
    }
  );

  fastify.post<{
    Body: {
      model?: unknown;
      action?: unknown;
      recordId?: unknown;
      payload?: unknown;
    };
  }>(
    '/api/v1/dock/realtime/publish',
    {
      schema: {
        tags: ['System'],
        summary: 'Publish a structured realtime change event onto DockEventBus',
      },
    },
    async (req, reply) => {
      if (publishToken) {
        const providedHeader = req.headers['x-dock-realtime-token'];
        const providedToken = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;
        if (providedToken !== publishToken && !req.auth) {
          return reply.code(401).send({
            success: false,
            error: 'Authentication required',
            code: 'UNAUTHORIZED',
            requestId: req.id,
          });
        }
      } else if (requireAuthForPublish && !req.auth) {
        return reply.code(401).send({
          success: false,
          error: 'Authentication required',
          code: 'UNAUTHORIZED',
          requestId: req.id,
        });
      }

      const body = req.body;
      const model = typeof body?.model === 'string' ? body.model.trim() : '';
      const action = typeof body?.action === 'string' ? body.action.trim() : '';
      if (!model || !action) {
        return reply.code(400).send({
          success: false,
          error: 'Both model and action must be non-empty strings',
          code: 'INVALID_REALTIME_EVENT',
          requestId: req.id,
        });
      }

      const rawRecordId = body.recordId;
      const recordId =
        typeof rawRecordId === 'string' || typeof rawRecordId === 'number' ? rawRecordId : null;
      const payload =
        typeof body.payload === 'object' && body.payload !== null && !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : {};

      const event = bus.publish({
        model,
        action,
        recordId,
        payload,
      });

      return reply.code(202).send({
        ok: true,
        event,
      });
    }
  );
};
