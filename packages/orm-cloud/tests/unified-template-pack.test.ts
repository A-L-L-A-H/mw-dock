import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalTemplateSlug,
  clearUnifiedTemplateCatalogCache,
  fetchMwEchoBlueprintCatalog,
  loadBigbearTemplateCatalog,
  loadDokployTemplateCatalog,
  loadUnifiedTemplateCatalog,
} from '../src/unified-template-pack.js';
import {
  clearCoolifyTemplateCatalogCache,
  loadCoolifyTemplateCatalog,
} from '../src/coolify-template-pack.js';

describe('canonicalTemplateSlug', () => {
  it('strips DB-suffix variants', () => {
    expect(canonicalTemplateSlug('forgejo-with-mariadb')).toBe('forgejo');
    expect(canonicalTemplateSlug('gitea-with-postgres')).toBe('gitea');
    expect(canonicalTemplateSlug('keycloak-with-postgres')).toBe('keycloak');
    expect(canonicalTemplateSlug('docuseal-with-postgres')).toBe('docuseal');
    expect(canonicalTemplateSlug('flowise-with-databases')).toBe('flowise');
    // Runner variant collapses to the base app too — same tool, different recipe.
    expect(canonicalTemplateSlug('forgejo-with-runner-with-mariadb')).toBe('forgejo');
    expect(canonicalTemplateSlug('forgejo-with-runner')).toBe('forgejo');
  });

  it('strips version suffixes and normalizes underscores', () => {
    expect(canonicalTemplateSlug('odoo_17')).toBe('odoo');
    expect(canonicalTemplateSlug('odoo_18')).toBe('odoo');
    expect(canonicalTemplateSlug('n8n-queue')).toBe('n8n-queue');
  });

  it('keeps plain slugs unchanged', () => {
    expect(canonicalTemplateSlug('uptime-kuma')).toBe('uptime-kuma');
    expect(canonicalTemplateSlug('ghost')).toBe('ghost');
  });
});

describe('graceful empty catalog when static template packs are absent', () => {
  beforeEach(() => {
    clearUnifiedTemplateCatalogCache();
    clearCoolifyTemplateCatalogCache();
  });

  it('returns empty maps for coolify, dokploy, bigbear, and unified catalog without throwing', () => {
    const prevCoolify = process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    const prevDokploy = process.env.MW_DOKPLOY_TEMPLATE_PACK_DIR;
    const prevBigbear = process.env.MW_BIGBEAR_TEMPLATE_PACK_DIR;
    delete process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    delete process.env.MW_DOKPLOY_TEMPLATE_PACK_DIR;
    delete process.env.MW_BIGBEAR_TEMPLATE_PACK_DIR;

    try {
      expect(loadCoolifyTemplateCatalog().size).toBe(0);
      expect(loadDokployTemplateCatalog().size).toBe(0);
      expect(loadBigbearTemplateCatalog().size).toBe(0);

      const unified = loadUnifiedTemplateCatalog();
      expect(unified.byCanonical.size).toBe(0);
      expect(unified.all.size).toBe(0);
      expect(unified.duplicates).toEqual([]);
    } finally {
      if (prevCoolify !== undefined) process.env.MW_COOLIFY_TEMPLATE_PACK_DIR = prevCoolify;
      if (prevDokploy !== undefined) process.env.MW_DOKPLOY_TEMPLATE_PACK_DIR = prevDokploy;
      if (prevBigbear !== undefined) process.env.MW_BIGBEAR_TEMPLATE_PACK_DIR = prevBigbear;
    }
  });
});

describe('loadUnifiedTemplateCatalog (fixture-backed cross-pack merge)', () => {
  let fixtureRoot: string;
  let prevCoolify: string | undefined;
  let prevDokploy: string | undefined;
  let prevBigbear: string | undefined;

  beforeAll(() => {
    prevCoolify = process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    prevDokploy = process.env.MW_DOKPLOY_TEMPLATE_PACK_DIR;
    prevBigbear = process.env.MW_BIGBEAR_TEMPLATE_PACK_DIR;

    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mw-unified-pack-fixture-'));
    const coolifyDir = path.join(fixtureRoot, 'coolify');
    const dokployDir = path.join(fixtureRoot, 'dokploy');
    const bigbearDir = path.join(fixtureRoot, 'bigbear');

    mkdirSync(coolifyDir, { recursive: true });
    mkdirSync(path.join(dokployDir, 'blueprints', 'uptime-kuma'), { recursive: true });
    mkdirSync(path.join(dokployDir, 'blueprints', 'forgejo'), { recursive: true });
    mkdirSync(path.join(bigbearDir, 'apps', 'actual-server'), { recursive: true });
    mkdirSync(path.join(bigbearDir, 'apps', 'adguard-home'), { recursive: true });

    const encode = (yaml: string) => Buffer.from(yaml.trim(), 'utf8').toString('base64');
    writeFileSync(
      path.join(coolifyDir, 'service-templates.json'),
      JSON.stringify({
        'forgejo-with-mariadb': {
          slogan: 'Self-hosted Git forge',
          category: 'development',
          compose: encode(`
services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:7
    volumes:
      - forgejo-data:/data
`),
        },
      }),
      'utf8',
    );

    writeFileSync(
      path.join(dokployDir, 'blueprints', 'uptime-kuma', 'docker-compose.yml'),
      `services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:1\n    volumes:\n      - kuma-data:/app/data\n`,
      'utf8',
    );
    writeFileSync(
      path.join(dokployDir, 'blueprints', 'uptime-kuma', 'meta.json'),
      JSON.stringify({
        name: 'Uptime Kuma',
        description: 'Self-hosted monitoring',
        categories: ['Monitoring'],
        tags: ['status', 'alerts'],
      }),
      'utf8',
    );
    writeFileSync(
      path.join(dokployDir, 'blueprints', 'forgejo', 'docker-compose.yml'),
      `services:\n  forgejo:\n    image: codeberg.org/forgejo/forgejo:7\n    volumes:\n      - forgejo-data:/data\n`,
      'utf8',
    );

    writeFileSync(
      path.join(bigbearDir, 'apps', 'actual-server', 'docker-compose.yml'),
      `services:\n  actual-server:\n    image: actualbudget/actual-server:latest\n    volumes:\n      - actual-data:/data\n    x-casaos:\n      title:\n        en: Actual Budget\n      tagline:\n        en: Local-first personal finance\n      category: Finance\n`,
      'utf8',
    );
    writeFileSync(
      path.join(bigbearDir, 'apps', 'adguard-home', 'docker-compose.yml'),
      `services:\n  adguard-home:\n    image: adguard/adguardhome:latest\n    volumes:\n      - /DATA/AppData/adguard/work:/opt/adguardhome/work\n    x-casaos:\n      title:\n        en: AdGuard Home\n      category: Network\n`,
      'utf8',
    );

    process.env.MW_COOLIFY_TEMPLATE_PACK_DIR = coolifyDir;
    process.env.MW_DOKPLOY_TEMPLATE_PACK_DIR = dokployDir;
    process.env.MW_BIGBEAR_TEMPLATE_PACK_DIR = bigbearDir;
  });

  afterAll(() => {
    if (prevCoolify === undefined) delete process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    else process.env.MW_COOLIFY_TEMPLATE_PACK_DIR = prevCoolify;
    if (prevDokploy === undefined) delete process.env.MW_DOKPLOY_TEMPLATE_PACK_DIR;
    else process.env.MW_DOKPLOY_TEMPLATE_PACK_DIR = prevDokploy;
    if (prevBigbear === undefined) delete process.env.MW_BIGBEAR_TEMPLATE_PACK_DIR;
    else process.env.MW_BIGBEAR_TEMPLATE_PACK_DIR = prevBigbear;
    clearUnifiedTemplateCatalogCache();
    clearCoolifyTemplateCatalogCache();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearUnifiedTemplateCatalogCache();
    clearCoolifyTemplateCatalogCache();
  });

  it('loads raw entries from fixture packs via env overrides', () => {
    const dokploy = loadDokployTemplateCatalog();
    const bigbear = loadBigbearTemplateCatalog();
    expect(dokploy.size).toBe(2);
    expect(bigbear.size).toBe(2);

    const dokployEntry = dokploy.get('uptime-kuma');
    expect(dokployEntry?.source).toBe('dokploy');
    expect(dokployEntry?.composeYaml).toContain('services:');

    const bigbearEntry = bigbear.get('actual-server');
    expect(bigbearEntry?.source).toBe('bigbear');
    expect(bigbearEntry?.name.toLowerCase()).toContain('actual');
  });

  it('dedupes canonical apps across packs with dokploy precedence', () => {
    const unified = loadUnifiedTemplateCatalog();
    const forgejo = unified.byCanonical.get('forgejo');
    expect(forgejo).toBeDefined();
    expect(forgejo?.source).toBe('dokploy');
    expect(forgejo?.duplicateSources).toContain('coolify');
    expect(unified.duplicates.length).toBe(1);
  });

  it('classifies compatibility against control-plane rules', () => {
    const unified = loadUnifiedTemplateCatalog();
    for (const entry of unified.all.values()) {
      if (entry.compatibility === 'restricted') {
        expect(entry.compatibilityReasons.length).toBeGreaterThan(0);
      }
    }
    const adguard = loadBigbearTemplateCatalog().get('adguard-home');
    expect(adguard?.compatibility).toBe('restricted');
    expect(adguard?.compatibilityReasons.some((reason) => reason.includes('host bind'))).toBe(true);
  });

  it('keeps every entry keyed with source prefix in all-map', () => {
    const unified = loadUnifiedTemplateCatalog();
    expect(unified.all.has('dokploy:uptime-kuma')).toBe(true);
    expect(unified.all.has('bigbear:actual-server')).toBe(true);
    expect(unified.all.size).toBeGreaterThan(unified.byCanonical.size);
  });
});

describe('fetchMwEchoBlueprintCatalog', () => {
  it('returns an empty map when echoUrl is unset', async () => {
    const catalog = await fetchMwEchoBlueprintCatalog('');
    expect(catalog.size).toBe(0);
  });

  it('fetches and classifies blueprints dynamically from mw-echo /api/blueprints', async () => {
    const requestedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify({
          blueprints: [
            {
              id: 'curated:postgres-16',
              source: 'curated',
              slug: 'postgres-16',
              name: 'PostgreSQL 16',
              category: 'database',
              description: 'Production PostgreSQL 16 database',
              tags: ['postgres', 'database'],
              sourceUrl: 'https://hub.docker.com/_/postgres',
              composeYaml: `services:\n  postgres:\n    image: postgres:16-alpine\n    volumes:\n      - postgres_data:/var/lib/postgresql/data\n`,
            },
            {
              id: 'dokploy:n8n',
              source: 'dokploy',
              slug: 'n8n',
              name: 'n8n',
              category: 'automation',
              description: 'Workflow automation',
              tags: ['automation'],
              composeYaml: `services:\n  n8n:\n    image: docker.n8n.io/n8nio/n8n:latest\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`,
            },
          ],
          count: 2,
          sources: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const catalog = await fetchMwEchoBlueprintCatalog('http://mw-echo:4310/', {
      fetchImpl: mockFetch,
      query: 'postgres',
      limit: 50,
    });

    expect(requestedUrls).toEqual(['http://mw-echo:4310/api/blueprints?q=postgres&limit=50']);
    expect(catalog.size).toBe(2);

    const postgres = catalog.get('postgres-16');
    expect(postgres).toMatchObject({
      id: 'postgres-16',
      canonicalId: 'postgres',
      name: 'PostgreSQL 16',
      category: 'database',
      source: 'mw-echo',
      compatibility: 'ready',
      serviceCount: 1,
      services: ['postgres'],
    });

    const n8n = catalog.get('n8n');
    expect(n8n?.source).toBe('dokploy');
    expect(n8n?.compatibility).toBe('restricted');
  });

  it('gracefully returns an empty map when mw-echo is unreachable or returns non-2xx', async () => {
    const errorCatalog = await fetchMwEchoBlueprintCatalog('http://127.0.0.1:4310', {
      fetchImpl: async () => new Response('service unavailable', { status: 503 }),
    });
    expect(errorCatalog.size).toBe(0);

    const offlineCatalog = await fetchMwEchoBlueprintCatalog('http://127.0.0.1:4310', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(offlineCatalog.size).toBe(0);
  });
});
