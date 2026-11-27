import Fastify, { type FastifyInstance } from 'fastify';
import knex, { type Knex } from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BILLING_TIERS } from '@moonwitness/orm-cloud';
import { Company, CompanyMembership, Partner, User } from '@moonwitness/orm-base';
import { buildApp } from '../src/app.js';
import tenantQuotaPlugin, {
  InMemoryTenantQuotaStore,
  KnexTenantQuotaStore,
  resolveTenantPlanLimits,
  type TenantQuotaStore,
} from '../src/middleware/tenant-quota.js';

const TEST_JWT_SECRET = 'test-secret-test-secret-test-secret-123';
const ADMIN_PASSWORD = 'admin-quota-test-password';

function createMemorySqliteDb(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
}

async function createQuotaTestApp(options: {
  store?: TenantQuotaStore;
  db?: Knex;
  now?: () => number;
  defaultPlan?: string;
  customPlans?: Record<string, { maxRequestsPerWindow?: number; windowMs?: number; plan?: string }>;
  resolveTenantConfig?: (
    tenantId: string
  ) =>
    | string
    | { plan?: string; limits?: { maxRequestsPerWindow?: number; windowMs?: number; plan?: string } }
    | undefined;
  exemptPaths?: readonly string[];
  exemptRoles?: readonly string[];
  requireTenant?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const companyHeader = request.headers['x-auth-company-id'];
    const roleHeader = request.headers['x-auth-role'];
    if (companyHeader !== undefined || roleHeader !== undefined) {
      const companyId =
        typeof companyHeader === 'string' && /^\d+$/u.test(companyHeader)
          ? Number(companyHeader)
          : undefined;
      request.auth = {
        userId: 1,
        role: (typeof roleHeader === 'string' ? roleHeader : 'user') as 'user' | 'superadmin' | 'system',
        companyId,
        groupPermissions: [],
        groupNames: [],
      };
    }
  });

  await app.register(tenantQuotaPlugin, {
    store: options.store,
    db: options.db,
    now: options.now,
    defaultPlan: options.defaultPlan,
    customPlans: options.customPlans,
    resolveTenantConfig: options.resolveTenantConfig
      ? (tenantId) => options.resolveTenantConfig!(tenantId)
      : undefined,
    exemptPaths: options.exemptPaths,
    exemptRoles: options.exemptRoles,
    requireTenant: options.requireTenant,
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/auth/login', async () => ({ ok: true }));
  app.get('/api/v1/items', async () => ({ ok: true }));
  app.get('/api/v1/custom-exempt', async () => ({ ok: true }));
  app.get('/api/v1/route-exempt', { config: { quotaExempt: true } }, async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe('tenant quota middleware', () => {
  const appsToClose: FastifyInstance[] = [];
  const dbsToClose: Knex[] = [];

  afterEach(async () => {
    while (appsToClose.length > 0) {
      const app = appsToClose.pop()!;
      await app.close();
    }
    while (dbsToClose.length > 0) {
      const db = dbsToClose.pop()!;
      await db.destroy();
    }
  });

  it('aligns default plan limits with @moonwitness/orm-cloud billing tiers and merges custom plans', () => {
    const free = resolveTenantPlanLimits('free');
    const pro = resolveTenantPlanLimits(' PRO ');
    const fallback = resolveTenantPlanLimits('nonexistent');

    expect(free.maxApps).toBe(DEFAULT_BILLING_TIERS.free.quotaLimits.maxApps);
    expect(free.maxRamMb).toBe(DEFAULT_BILLING_TIERS.free.quotaLimits.maxRamMb);
    expect(pro.maxApps).toBe(DEFAULT_BILLING_TIERS.pro.quotaLimits.maxApps);
    expect(pro.maxCustomDomains).toBe(DEFAULT_BILLING_TIERS.pro.quotaLimits.maxCustomDomains);
    expect(pro.allowDedicatedMesh).toBe(DEFAULT_BILLING_TIERS.pro.quotaLimits.allowDedicatedMesh);
    expect(fallback.plan).toBe('free');

    const custom = resolveTenantPlanLimits('burst', {
      burst: { plan: 'burst', maxRequestsPerWindow: 250, windowMs: 30_000 },
    });
    expect(custom.plan).toBe('burst');
    expect(custom.maxRequestsPerWindow).toBe(250);
    expect(custom.windowMs).toBe(30_000);
    expect(custom.maxApps).toBe(DEFAULT_BILLING_TIERS.free.quotaLimits.maxApps);
  });

  describe.each([
    {
      name: 'InMemoryTenantQuotaStore',
      createStore: (now: () => number) => {
        const store = new InMemoryTenantQuotaStore(now);
        return { store };
      },
    },
    {
      name: 'KnexTenantQuotaStore (better-sqlite3 :memory:)',
      createStore: (now: () => number) => {
        const db = createMemorySqliteDb();
        dbsToClose.push(db);
        const store = new KnexTenantQuotaStore(db, now);
        return { store, db };
      },
    },
  ])('$name', ({ createStore }) => {
    it('sets x-quota-* headers under limit and returns 429 TENANT_QUOTA_EXCEEDED on exceed', async () => {
      let currentNowMs = 1_700_000_040_000;
      const now = () => currentNowMs;
      const { store } = createStore(now);

      const app = await createQuotaTestApp({
        store,
        now,
        defaultPlan: 'starter',
        customPlans: {
          starter: { maxRequestsPerWindow: 3, windowMs: 60_000 },
        },
      });
      appsToClose.push(app);

      const first = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-alpha' },
      });
      expect(first.statusCode).toBe(200);
      expect(first.headers['x-quota-limit']).toBe('3');
      expect(first.headers['x-quota-remaining']).toBe('2');
      expect(first.headers['x-quota-plan']).toBe('starter');
      expect(Number(first.headers['x-quota-reset'])).toBeGreaterThan(
        Math.floor(currentNowMs / 1000)
      );

      const second = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-alpha' },
      });
      expect(second.statusCode).toBe(200);
      expect(second.headers['x-quota-remaining']).toBe('1');

      const third = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-alpha' },
      });
      expect(third.statusCode).toBe(200);
      expect(third.headers['x-quota-remaining']).toBe('0');

      const exceeded = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-alpha' },
      });
      expect(exceeded.statusCode).toBe(429);
      expect(exceeded.headers['x-quota-limit']).toBe('3');
      expect(exceeded.headers['x-quota-remaining']).toBe('0');
      expect(exceeded.headers['x-quota-plan']).toBe('starter');
      expect(Number(exceeded.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      const body = exceeded.json<{
        success: boolean;
        error: string;
        code: string;
        data: {
          tenantId: string;
          plan: string;
          limit: number;
          used: number;
          remaining: number;
          resetAt: string;
        };
      }>();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Tenant quota exceeded');
      expect(body.code).toBe('TENANT_QUOTA_EXCEEDED');
      expect(body.data).toMatchObject({
        tenantId: 'tenant-alpha',
        plan: 'starter',
        limit: 3,
        used: 4,
        remaining: 0,
      });
      expect(Date.parse(body.data.resetAt)).toBeGreaterThan(currentNowMs);
    });

    it('isolates quotas across tenants and resets usage after window expiration', async () => {
      let currentNowMs = 1_700_000_000_000;
      const now = () => currentNowMs;
      const { store } = createStore(now);

      const app = await createQuotaTestApp({
        store,
        now,
        customPlans: {
          free: { maxRequestsPerWindow: 2, windowMs: 10_000 },
        },
      });
      appsToClose.push(app);

      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/items',
            headers: { 'x-auth-company-id': '1' },
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/items',
            headers: { 'x-auth-company-id': '1' },
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/items',
            headers: { 'x-auth-company-id': '1' },
          })
        ).statusCode
      ).toBe(429);

      const tenant2 = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-auth-company-id': '2' },
      });
      expect(tenant2.statusCode).toBe(200);
      expect(tenant2.headers['x-quota-remaining']).toBe('1');

      currentNowMs += 10_000;
      const afterReset = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-auth-company-id': '1' },
      });
      expect(afterReset.statusCode).toBe(200);
      expect(afterReset.headers['x-quota-remaining']).toBe('1');

      if (store.pruneExpired) {
        const pruned = await store.pruneExpired(currentNowMs);
        expect(pruned).toBeGreaterThanOrEqual(2);
      }
    });

    it('exempts /health, /auth/*, custom exemptPaths, and route quotaExempt from quota enforcement', async () => {
      const currentNowMs = 1_700_000_000_000;
      const now = () => currentNowMs;
      const { store } = createStore(now);

      const app = await createQuotaTestApp({
        store,
        now,
        exemptPaths: ['/api/v1/custom-exempt'],
        customPlans: {
          free: { maxRequestsPerWindow: 1, windowMs: 60_000 },
        },
      });
      appsToClose.push(app);

      const ok = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-exempt-check' },
      });
      expect(ok.statusCode).toBe(200);

      const blocked = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-exempt-check' },
      });
      expect(blocked.statusCode).toBe(429);

      for (const exemptUrl of [
        '/health',
        '/auth/login',
        '/api/v1/custom-exempt',
        '/api/v1/route-exempt',
      ]) {
        const res = await app.inject({
          method: 'GET',
          url: exemptUrl,
          headers: { 'x-tenant-id': 'tenant-exempt-check' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-quota-limit']).toBeUndefined();
      }
    });

    it('supports custom per-tenant plan resolution, exemptRoles, and requireTenant', async () => {
      const currentNowMs = 1_700_000_000_000;
      const now = () => currentNowMs;
      const { store } = createStore(now);

      const app = await createQuotaTestApp({
        store,
        now,
        exemptRoles: ['system'],
        requireTenant: true,
        customPlans: {
          free: { maxRequestsPerWindow: 1, windowMs: 60_000 },
          pro: { maxRequestsPerWindow: 4, windowMs: 60_000 },
        },
        resolveTenantConfig: (tenantId) => {
          if (tenantId === 'tenant-pro') return 'pro';
          if (tenantId === 'tenant-custom') {
            return {
              plan: 'vip',
              limits: { plan: 'vip', maxRequestsPerWindow: 2, windowMs: 60_000 },
            };
          }
          return 'free';
        },
      });
      appsToClose.push(app);

      const missingTenant = await app.inject({ method: 'GET', url: '/api/v1/items' });
      expect(missingTenant.statusCode).toBe(400);
      expect(missingTenant.json<{ code: string }>().code).toBe('TENANT_REQUIRED');

      const systemReq = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-auth-role': 'system' },
      });
      expect(systemReq.statusCode).toBe(200);

      const pro1 = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-pro' },
      });
      expect(pro1.statusCode).toBe(200);
      expect(pro1.headers['x-quota-plan']).toBe('pro');
      expect(pro1.headers['x-quota-limit']).toBe('4');
      expect(pro1.headers['x-quota-remaining']).toBe('3');

      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/items',
            headers: { 'x-tenant-id': 'tenant-custom' },
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/items',
            headers: { 'x-tenant-id': 'tenant-custom' },
          })
        ).statusCode
      ).toBe(200);
      const vipBlocked = await app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { 'x-tenant-id': 'tenant-custom' },
      });
      expect(vipBlocked.statusCode).toBe(429);
      expect(vipBlocked.headers['x-quota-plan']).toBe('vip');
    });
  });

  it('integrates with buildApp using request.auth.companyId and KnexTenantQuotaStore', async () => {
    process.env.NODE_ENV = 'test';
    const db = createMemorySqliteDb();
    let currentNowMs = 1_700_000_000_000;

    const app = await buildApp({
      db,
      superadminPassword: ADMIN_PASSWORD,
      jwtSecret: TEST_JWT_SECRET,
      loginRateMax: 1000,
      tenantQuota: {
        now: () => currentNowMs,
        customPlans: {
          free: { maxRequestsPerWindow: 2, windowMs: 60_000 },
        },
      },
    });
    appsToClose.push(app);
    await app.ready();

    const company = await Company.query().findOne({ name: 'MoonWitness' }).throwIfNotFound();
    const partner = await Partner.query().insert({ name: 'Quota User', company_id: company.id });
    const quotaUser = await User.query().insertAndFetch({
      login: 'quota-user',
      password: 'quota-user-password',
      partner_id: partner.id,
      role: 'user',
    });
    await CompanyMembership.query().insert({
      user_id: quotaUser.id,
      company_id: company.id,
      is_default: true,
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'quota-user', password: 'quota-user-password' },
    });
    expect(loginRes.statusCode).toBe(200);
    const token = loginRes.json<{ data: { access_token: string } }>().data.access_token;

    const r1 = await app.inject({
      method: 'GET',
      url: '/api/app/bootstrap',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['x-quota-limit']).toBe('2');
    expect(r1.headers['x-quota-remaining']).toBe('1');

    const r2 = await app.inject({
      method: 'GET',
      url: '/api/app/bootstrap',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['x-quota-remaining']).toBe('0');

    const r3 = await app.inject({
      method: 'GET',
      url: '/api/app/bootstrap',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r3.statusCode).toBe(429);
    expect(r3.json<{ code: string }>().code).toBe('TENANT_QUOTA_EXCEEDED');

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    currentNowMs += 60_000;
    const r4 = await app.inject({
      method: 'GET',
      url: '/api/app/bootstrap',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r4.statusCode).toBe(200);
    expect(r4.headers['x-quota-remaining']).toBe('1');
  });

  it('respects tenantQuota: false even when TENANT_QUOTA_ENABLED=true', async () => {
    const prevEnabled = process.env.TENANT_QUOTA_ENABLED;
    process.env.TENANT_QUOTA_ENABLED = 'true';
    const db = createMemorySqliteDb();

    try {
      const app = await buildApp({
        db,
        superadminPassword: ADMIN_PASSWORD,
        jwtSecret: TEST_JWT_SECRET,
        loginRateMax: 1000,
        tenantQuota: false,
      });
      appsToClose.push(app);
      await app.ready();

      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { login: 'superadmin', password: ADMIN_PASSWORD },
      });
      const token = loginRes.json<{ data: { access_token: string } }>().data.access_token;

      const res = await app.inject({
        method: 'GET',
        url: '/api/app/bootstrap',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-quota-limit']).toBeUndefined();
    } finally {
      if (prevEnabled === undefined) delete process.env.TENANT_QUOTA_ENABLED;
      else process.env.TENANT_QUOTA_ENABLED = prevEnabled;
    }
  });
});
