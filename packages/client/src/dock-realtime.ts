import type { FieldMeta } from '@moonwitness/types';

export interface DockSchemaModel {
  readonly name: string;
  readonly label: string;
  readonly fieldCount: number;
  readonly fields: FieldMeta[];
}

export interface DockSchemaResponse {
  readonly addons: string[];
  readonly modelCount: number;
  readonly models: DockSchemaModel[];
}

export interface DockRealtimeEvent {
  readonly id: string;
  readonly model: string;
  readonly action: string;
  readonly recordId: string | number | null;
  readonly payload: Record<string, unknown>;
  readonly ts: string;
}

export interface DockFetchOptions {
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}

export interface DockRealtimeSubscriptionOptions extends DockFetchOptions {
  readonly model?: string;
  readonly onConnected?: (info: { id: string; model: string | null; ts: string }) => void;
  readonly onHeartbeat?: (info: { id: string; ts: string }) => void;
  readonly onError?: (error: Error) => void;
}

export interface DockRealtimeSubscription {
  close(): void;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

export async function fetchDockSchema(
  baseUrl: string,
  opts: DockFetchOptions = {}
): Promise<DockSchemaResponse> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...opts.headers,
  };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/dock/studio/schema`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: opts.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Dock schema (${response.status} ${response.statusText})`);
  }

  return (await response.json()) as DockSchemaResponse;
}

interface ParsedSseFrame {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

function parseSseBlock(block: string): ParsedSseFrame | null {
  const lines = block.split(/\r?\n/u);
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    const rawValue = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'id') {
      id = value;
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join('\n'),
    id,
  };
}

export function subscribeDockRealtime(
  baseUrl: string,
  onEvent: (event: DockRealtimeEvent) => void,
  opts: DockRealtimeSubscriptionOptions = {}
): DockRealtimeSubscription {
  const query = opts.model ? `?model=${encodeURIComponent(opts.model)}` : '';
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/dock/realtime${query}`;

  const canUseEventSource =
    typeof globalThis.EventSource === 'function' &&
    !opts.fetch &&
    !opts.token &&
    !opts.headers &&
    !opts.signal;

  if (canUseEventSource) {
    const source = new globalThis.EventSource(url);
    source.addEventListener('change', (message) => {
      try {
        const parsed = JSON.parse((message as MessageEvent<string>).data) as DockRealtimeEvent;
        onEvent(parsed);
      } catch (error) {
        opts.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (opts.onConnected) {
      source.addEventListener('connected', (message) => {
        try {
          opts.onConnected?.(
            JSON.parse((message as MessageEvent<string>).data) as {
              id: string;
              model: string | null;
              ts: string;
            }
          );
        } catch (error) {
          opts.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    if (opts.onHeartbeat) {
      source.addEventListener('heartbeat', (message) => {
        try {
          opts.onHeartbeat?.(
            JSON.parse((message as MessageEvent<string>).data) as { id: string; ts: string }
          );
        } catch (error) {
          opts.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    source.onerror = () => {
      opts.onError?.(new Error('Dock realtime EventSource connection error'));
    };

    return {
      close() {
        source.close();
      },
    };
  }

  const controller = new AbortController();
  const externalSignal = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...opts.headers,
  };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  void (async () => {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Dock realtime stream failed (${response.status} ${response.statusText})`);
      }

      const body = response.body;
      if (!body) {
        throw new Error('Dock realtime stream returned an empty response body');
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseSseBlock(block);
          if (frame) {
            if (frame.event === 'change') {
              onEvent(JSON.parse(frame.data) as DockRealtimeEvent);
            } else if (frame.event === 'connected') {
              opts.onConnected?.(
                JSON.parse(frame.data) as { id: string; model: string | null; ts: string }
              );
            } else if (frame.event === 'heartbeat') {
              opts.onHeartbeat?.(JSON.parse(frame.data) as { id: string; ts: string });
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      opts.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  })();

  return {
    close() {
      controller.abort();
    },
  };
}
