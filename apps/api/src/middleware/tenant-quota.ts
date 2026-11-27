import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import type { Knex } from 'knex';
import { DEFAULT_BILLING_TIERS, type BillingPlanTier } from '@moonwitness/orm-cloud';
import { errorEnvelope } from '../http/api-envelope.js';

export type TenantQuotaPlanTier = BillingPlanTier;

export interface TenantQuotaPlanLimits {
  readonly plan: string;
  readonly maxRequestsPerWindow: number;
  readonly windowMs: number;
  readonly maxApps: number;
  readonly maxRamMb: number;
  readonly maxCustomDomains: number;
  readonly allowDedicatedMesh: boolean;
}

export interface TenantQuotaUsage {
  readonly tenantId: string;
  readonly windowKey: string;
  readonly used: number;
  readonly resetAtMs: number;
}

export interface TenantQuotaConsumeInput {
  readonly tenantId: string;
  readonly windowMs: number;
  readonly nowMs?: number;
}

export interface TenantQuotaStore {
  consume(input: TenantQuotaConsumeInput): Promise<TenantQuotaUsage>;
  getUsage?(tenantId: string, windowKey: string, nowMs?: number): Promise<TenantQuotaUsage | null>;
  pruneExpired?(nowMs?: number): Promise<number>;
}

export interface TenantQuotaConfig {
  readonly plan?: string;
  readonly limits?: Partial<TenantQuotaPlanLimits>;
}

export interface TenantQuotaOptions {
  readonly enabled?: boolean;
  readonly store?: TenantQuotaStore;
  readonly db?: Knex;
  readonly defaultPlan?: string;
  readonly customPlans?: Readonly<Record<string, Partial<TenantQuotaPlanLimits>>>;
  readonly resolveTenantId?: (
    request: FastifyRequest
  ) => string | number | null | undefined | Promise<string | number | null | undefined>;
  readonly resolveTenantConfig?: (
    tenantId: string,
    request: FastifyRequest
  ) =>
    | TenantQuotaConfig
    | string
    | null
    | undefined
    | Promise<TenantQuotaConfig | string | null | undefined>;
  readonly exemptPaths?: readonly string[];
  readonly exemptRoles?: readonly string[];
  readonly requireTenant?: boolean;
  readonly now?: () => number;
}

export const DEFAULT_QUOTA_WINDOW_MS = 60_000;

export const DEFAULT_QUOTA_EXEMPT_PATHS: readonly string[] = Object.freeze([
  '/health',
  '/livez',
  '/readyz',
  '/metrics',
  '/docs*',
  '/auth/*',
]);

export const DEFAULT_TENANT_QUOTA_PLANS: Readonly<Record<TenantQuotaPlanTier, TenantQuotaPlanLimits>> =
  Object.freeze({
    free: Object.freeze({
      plan: 'free',
      maxRequestsPerWindow: 60,
      windowMs: DEFAULT_QUOTA_WINDOW_MS,
      maxApps: DEFAULT_BILLING_TIERS.free.quotaLimits.maxApps,
      maxRamMb: DEFAULT_BILLING_TIERS.free.quotaLimits.maxRamMb,
      maxCustomDomains: DEFAULT_BILLING_TIERS.free.quotaLimits.maxCustomDomains,
      allowDedicatedMesh: DEFAULT_BILLING_TIERS.free.quotaLimits.allowDedicatedMesh,
    }),
    starter: Object.freeze({
      plan: 'starter',
      maxRequestsPerWindow: 300,
      windowMs: DEFAULT_QUOTA_WINDOW_MS,
      maxApps: DEFAULT_BILLING_TIERS.starter.quotaLimits.maxApps,
      maxRamMb: DEFAULT_BILLING_TIERS.starter.quotaLimits.maxRamMb,
      maxCustomDomains: DEFAULT_BILLING_TIERS.starter.quotaLimits.maxCustomDomains,
      allowDedicatedMesh: DEFAULT_BILLING_TIERS.starter.quotaLimits.allowDedicatedMesh,
    }),
    pro: Object.freeze({
      plan: 'pro',
      maxRequestsPerWindow: 1_500,
      windowMs: DEFAULT_QUOTA_WINDOW_MS,
      maxApps: DEFAULT_BILLING_TIERS.pro.quotaLimits.maxApps,
      maxRamMb: DEFAULT_BILLING_TIERS.pro.quotaLimits.maxRamMb,
      maxCustomDomains: DEFAULT_BILLING_TIERS.pro.quotaLimits.maxCustomDomains,
      allowDedicatedMesh: DEFAULT_BILLING_TIERS.pro.quotaLimits.allowDedicatedMesh,
    }),
    enterprise: Object.freeze({
      plan: 'enterprise',
      maxRequestsPerWindow: 10_000,
      windowMs: DEFAULT_QUOTA_WINDOW_MS,
      maxApps: DEFAULT_BILLING_TIERS.enterprise.quotaLimits.maxApps,
      maxRamMb: DEFAULT_BILLING_TIERS.enterprise.quotaLimits.maxRamMb,
      maxCustomDomains: DEFAULT_BILLING_TIERS.enterprise.quotaLimits.maxCustomDomains,
      allowDedicatedMesh: DEFAULT_BILLING_TIERS.enterprise.quotaLimits.allowDedicatedMesh,
    }),
  });

export function resolveTenantPlanLimits(
  plan?: string,
  customPlans?: Readonly<Record<string, Partial<TenantQuotaPlanLimits>>>
): TenantQuotaPlanLimits {
  const normalized = plan?.trim().toLowerCase() || 'free';
  const builtin = Object.prototype.hasOwnProperty.call(DEFAULT_TENANT_QUOTA_PLANS, normalized)
    ? DEFAULT_TENANT_QUOTA_PLANS[normalized as TenantQuotaPlanTier]
    : undefined;

  const custom =
    customPlans && Object.prototype.hasOwnProperty.call(customPlans, normalized)
      ? customPlans[normalized]
      : undefined;

  if (custom) {
    const base = builtin ?? DEFAULT_TENANT_QUOTA_PLANS.free;
    return {
      ...base,
      ...custom,
      plan: custom.plan ?? normalized,
    };
  }

  return builtin ?? DEFAULT_TENANT_QUOTA_PLANS.free;
}

function computeFixedWindow(nowMs: number, windowMs: number): {
  windowKey: string;
  resetAtMs: number;
} {
  const safeWindowMs = Number.isFinite(windowMs) && windowMs >= 1 ? Math.floor(windowMs) : 1;
  const windowIndex = Math.floor(nowMs / safeWindowMs);
  const windowKey = `${safeWindowMs}:${windowIndex}`;
  const resetAtMs = (windowIndex + 1) * safeWindowMs;
  return { windowKey, resetAtMs };
}

interface InMemoryEntry {
  used: number;
  resetAtMs: number;
}

export class InMemoryTenantQuotaStore implements TenantQuotaStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private compositeKey(tenantId: string, windowKey: string): string {
    return `${tenantId}\0${windowKey}`;
  }

  async consume(input: TenantQuotaConsumeInput): Promise<TenantQuotaUsage> {
    const nowMs = input.nowMs ?? this.now();
    const { windowKey, resetAtMs } = computeFixedWindow(nowMs, input.windowMs);
    const key = this.compositeKey(input.tenantId, windowKey);
    const existing = this.entries.get(key);

    if (!existing || existing.resetAtMs <= nowMs) {
      if (this.entries.size >= 10_000) {
        await this.pruneExpired(nowMs);
      }
      this.entries.set(key, { used: 1, resetAtMs });
      return {
        tenantId: input.tenantId,
        windowKey,
        used: 1,
        resetAtMs,
      };
    }

    existing.used += 1;
    return {
      tenantId: input.tenantId,
      windowKey,
      used: existing.used,
      resetAtMs: existing.resetAtMs,
    };
  }

  async getUsage(
    tenantId: string,
    windowKey: string,
    nowMs = this.now()
  ): Promise<TenantQuotaUsage | null> {
    const key = this.compositeKey(tenantId, windowKey);
    const existing = this.entries.get(key);
    if (!existing || existing.resetAtMs <= nowMs) {
      return null;
    }
    return {
      tenantId,
      windowKey,
      used: existing.used,
      resetAtMs: existing.resetAtMs,
    };
  }

  async pruneExpired(nowMs = this.now()): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.resetAtMs <= nowMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

const QUOTA_TABLE_NAME = '_api_tenant_quotas';

export class KnexTenantQuotaStore implements TenantQuotaStore {
  private readonly db: Knex;
  private readonly now: () => number;
  private tableReadyPromise: Promise<void> | null = null;

  constructor(db: Knex, now: () => number = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  private async ensureTable(): Promise<void> {
    if (!this.tableReadyPromise) {
      this.tableReadyPromise = (async () => {
        const exists = await this.db.schema.hasTable(QUOTA_TABLE_NAME);
        if (!exists) {
          await this.db.schema.createTable(QUOTA_TABLE_NAME, (table) => {
            table.string('tenant_id', 255).notNullable();
            table.string('window_key', 128).notNullable();
            table.integer('used_count').notNullable();
            table.bigInteger('expires_at_ms').notNullable();
            table.primary(['tenant_id', 'window_key']);
            table.index(['expires_at_ms'], 'idx_api_tenant_quotas_expires');
          });
        }
      })().catch((error) => {
        this.tableReadyPromise = null;
        throw error;
      });
    }
    return this.tableReadyPromise;
  }

  async consume(input: TenantQuotaConsumeInput): Promise<TenantQuotaUsage> {
    await this.ensureTable();
    const nowMs = input.nowMs ?? this.now();
    const { windowKey, resetAtMs } = computeFixedWindow(nowMs, input.windowMs);
    const clientName = String(this.db.client?.config?.client ?? '').toLowerCase();
    const isPostgres =
      clientName === 'pg' || clientName === 'postgres' || clientName === 'postgresql';

    if (isPostgres) {
      const result = (await this.db.raw(
        `INSERT INTO "${QUOTA_TABLE_NAME}" ("tenant_id", "window_key", "used_count", "expires_at_ms")
         VALUES (?, ?, 1, ?)
         ON CONFLICT ("tenant_id", "window_key") DO UPDATE SET
           "used_count" = CASE
             WHEN "${QUOTA_TABLE_NAME}"."expires_at_ms" <= ? THEN 1
             ELSE "${QUOTA_TABLE_NAME}"."used_count" + 1
           END,
           "expires_at_ms" = CASE
             WHEN "${QUOTA_TABLE_NAME}"."expires_at_ms" <= ? THEN ?
             ELSE "${QUOTA_TABLE_NAME}"."expires_at_ms"
           END
         RETURNING "used_count", "expires_at_ms"`,
        [input.tenantId, windowKey, resetAtMs, nowMs, nowMs, resetAtMs]
      )) as { rows?: { used_count: number | string; expires_at_ms: number | string }[] };

      const row = result.rows?.[0];
      return {
        tenantId: input.tenantId,
        windowKey,
        used: Number(row?.used_count ?? 1),
        resetAtMs: Number(row?.expires_at_ms ?? resetAtMs),
      };
    }

    return this.db.transaction(async (trx) => {
      const existing = (await trx(QUOTA_TABLE_NAME)
        .where({ tenant_id: input.tenantId, window_key: windowKey })
        .first()) as { used_count: number | string; expires_at_ms: number | string } | undefined;

      if (!existing || Number(existing.expires_at_ms) <= nowMs) {
        await trx(QUOTA_TABLE_NAME)
          .insert({
            tenant_id: input.tenantId,
            window_key: windowKey,
            used_count: 1,
            expires_at_ms: resetAtMs,
          })
          .onConflict(['tenant_id', 'window_key'])
          .merge();
        return {
          tenantId: input.tenantId,
          windowKey,
          used: 1,
          resetAtMs,
        };
      }

      const nextUsed = Number(existing.used_count) + 1;
      await trx(QUOTA_TABLE_NAME)
        .where({ tenant_id: input.tenantId, window_key: windowKey })
        .update({ used_count: nextUsed });

      return {
        tenantId: input.tenantId,
        windowKey,
        used: nextUsed,
        resetAtMs: Number(existing.expires_at_ms),
      };
    });
  }

  async getUsage(
    tenantId: string,
    windowKey: string,
    nowMs = this.now()
  ): Promise<TenantQuotaUsage | null> {
    await this.ensureTable();
    const row = (await this.db(QUOTA_TABLE_NAME)
      .where({ tenant_id: tenantId, window_key: windowKey })
      .first()) as { used_count: number | string; expires_at_ms: number | string } | undefined;

    if (!row || Number(row.expires_at_ms) <= nowMs) {
      return null;
    }

    return {
      tenantId,
      windowKey,
      used: Number(row.used_count),
      resetAtMs: Number(row.expires_at_ms),
    };
  }

  async pruneExpired(nowMs = this.now()): Promise<number> {
    await this.ensureTable();
    return this.db(QUOTA_TABLE_NAME).where('expires_at_ms', '<=', nowMs).del();
  }
}

function matchesExemptPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(`${base}/`);
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  return path === pattern;
}

function isExemptPath(path: string, exemptPaths: readonly string[]): boolean {
  return exemptPaths.some((pattern) => matchesExemptPattern(path, pattern));
}

function normalizeTenantIdValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function defaultResolveTenantId(request: FastifyRequest): Promise<string | null> {
  const companyId = request.auth?.companyId;
  if (companyId !== undefined && companyId !== null) {
    return normalizeTenantIdValue(companyId);
  }
  const header = request.headers['x-tenant-id'];
  const candidate = Array.isArray(header) ? header[0] : header;
  return normalizeTenantIdValue(candidate);
}

export function createTenantQuotaMiddleware(
  options: TenantQuotaOptions = {}
): preHandlerHookHandler {
  const now = options.now ?? (() => Date.now());
  const store: TenantQuotaStore =
    options.store ??
    (options.db
      ? new KnexTenantQuotaStore(options.db, now)
      : new InMemoryTenantQuotaStore(now));
  const exemptPaths = [...DEFAULT_QUOTA_EXEMPT_PATHS, ...(options.exemptPaths ?? [])];
  const exemptRoles = new Set(options.exemptRoles ?? []);

  return async function tenantQuotaPreHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (options.enabled === false) return;
    if (request.method === 'OPTIONS') return;

    const routeUrl = request.routeOptions.url;
    if (routeUrl === undefined) return;

    const routeConfig = request.routeOptions.config as { quotaExempt?: boolean } | undefined;
    if (routeConfig?.quotaExempt === true) return;

    const requestPath = request.url.split('?', 1)[0] ?? routeUrl;
    if (isExemptPath(routeUrl, exemptPaths) || isExemptPath(requestPath, exemptPaths)) {
      return;
    }

    if (request.auth?.role && exemptRoles.has(request.auth.role)) {
      return;
    }

    const resolvedRaw = options.resolveTenantId
      ? await options.resolveTenantId(request)
      : await defaultResolveTenantId(request);
    const tenantId = normalizeTenantIdValue(resolvedRaw);

    if (!tenantId) {
      if (options.requireTenant) {
        return reply
          .status(400)
          .send(errorEnvelope('Tenant context is required', 'TENANT_REQUIRED', { request }));
      }
      return;
    }

    const tenantConfig = options.resolveTenantConfig
      ? await options.resolveTenantConfig(tenantId, request)
      : undefined;
    const planName =
      typeof tenantConfig === 'string'
        ? tenantConfig
        : (tenantConfig?.plan ?? options.defaultPlan ?? 'free');
    const baseLimits = resolveTenantPlanLimits(planName, options.customPlans);
    const customLimits = typeof tenantConfig === 'object' ? tenantConfig?.limits : undefined;
    const limits: TenantQuotaPlanLimits = customLimits
      ? {
          ...baseLimits,
          ...customLimits,
          plan: customLimits.plan ?? baseLimits.plan,
        }
      : baseLimits;

    const maxRequests = Math.max(0, Math.floor(limits.maxRequestsPerWindow));
    const currentNowMs = now();
    const usage = await store.consume({
      tenantId,
      windowMs: limits.windowMs,
      nowMs: currentNowMs,
    });

    const remaining = Math.max(0, maxRequests - usage.used);
    const resetEpochSeconds = Math.ceil(usage.resetAtMs / 1000);

    reply.header('x-quota-limit', String(maxRequests));
    reply.header('x-quota-remaining', String(remaining));
    reply.header('x-quota-reset', String(resetEpochSeconds));
    reply.header('x-quota-plan', limits.plan);

    if (usage.used > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((usage.resetAtMs - currentNowMs) / 1000));
      const resetAt = new Date(usage.resetAtMs).toISOString();
      reply.header('retry-after', String(retryAfterSeconds));
      return reply.status(429).send(
        errorEnvelope('Tenant quota exceeded', 'TENANT_QUOTA_EXCEEDED', {
          request,
          data: {
            tenantId,
            plan: limits.plan,
            limit: maxRequests,
            used: usage.used,
            remaining: 0,
            resetAt,
          },
        })
      );
    }
  };
}

const tenantQuotaPluginAsync: FastifyPluginAsync<TenantQuotaOptions> = async (
  fastify,
  options
) => {
  if (options.enabled === false) return;

  const now = options.now ?? (() => Date.now());
  const db =
    options.db ??
    (fastify.hasDecorator('db') ? (fastify as unknown as { db?: Knex }).db : undefined);
  const store =
    options.store ??
    (db ? new KnexTenantQuotaStore(db, now) : new InMemoryTenantQuotaStore(now));

  fastify.addHook('preHandler', createTenantQuotaMiddleware({ ...options, store, now }));
};

export const tenantQuotaPlugin = fp(tenantQuotaPluginAsync, {
  name: 'moonwitness-tenant-quota',
  fastify: '5.x',
});

export default tenantQuotaPlugin;
