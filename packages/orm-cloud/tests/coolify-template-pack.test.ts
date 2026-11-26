import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearCoolifyTemplateCatalogCache,
  compileCoolifyCompose,
  getCoolifyTemplateDetail,
  listCoolifyTemplates,
  loadCoolifyTemplateCatalog,
} from '../src/index.js';

function encodeCompose(yaml: string): string {
  return Buffer.from(yaml.trim(), 'utf8').toString('base64');
}

const FIXTURE_TEMPLATES: Record<string, Record<string, unknown>> = {
  n8n: {
    slogan: 'Workflow automation platform',
    category: 'automation',
    tags: ['automation', 'workflows'],
    port: 5678,
    compose: encodeCompose(`
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    environment:
      - SERVICE_FQDN_N8N_5678
      - GENERIC_TIMEZONE=\${TZ:-UTC}
    volumes:
      - n8n-data:/home/node/.n8n
`),
  },
  'uptime-kuma': {
    slogan: 'Self-hosted uptime monitoring tool',
    category: 'monitoring',
    tags: ['monitoring', 'status'],
    port: 3001,
    compose: encodeCompose(`
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    environment:
      - SERVICE_FQDN_UPTIMEKUMA_3001
    volumes:
      - uptime-kuma-data:/app/data
`),
  },
  activepieces: {
    slogan: 'Open source workflow automation',
    category: 'automation',
    tags: ['automation', 'ai'],
    port: 80,
    compose: encodeCompose(`
services:
  activepieces:
    image: ghcr.io/activepieces/activepieces:latest
    environment:
      - SERVICE_FQDN_ACTIVEPIECES_80
      - SERVICE_USER_POSTGRES
      - SERVICE_PASSWORD_POSTGRES
      - AP_POSTGRES_USERNAME=\${SERVICE_USER_POSTGRES}
      - AP_POSTGRES_PASSWORD=\${SERVICE_PASSWORD_POSTGRES}
    volumes:
      - ap-cache:/usr/src/app/cache
  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=\${SERVICE_USER_POSTGRES}
      - POSTGRES_PASSWORD=\${SERVICE_PASSWORD_POSTGRES}
    volumes:
      - pg-data:/var/lib/postgresql/data
`),
  },
  ghost: {
    slogan: 'Independent publishing platform',
    category: 'cms',
    tags: ['blog', 'publishing'],
    port: 2368,
    compose: encodeCompose(`
services:
  ghost:
    image: ghost:5-alpine
    environment:
      - SERVICE_FQDN_GHOST_2368
    volumes:
      - ghost-content:/var/lib/ghost/content
`),
  },
  affine: {
    slogan: 'Collaborative knowledge base and whiteboard',
    category: 'productivity',
    tags: ['wiki', 'notes'],
    port: 3010,
    compose: encodeCompose(`
services:
  affine:
    image: ghcr.io/toeverything/affine-graphql:stable
    exclude_from_hc: true
    environment:
      - SERVICE_FQDN_AFFINE_3010
    volumes:
      - affine-storage:/root/.affine/storage
`),
  },
  alexandrie: {
    slogan: 'Markdown note taking with separate frontend and API',
    category: 'productivity',
    tags: ['notes', 'markdown'],
    port: 3000,
    compose: encodeCompose(`
services:
  frontend:
    image: ghcr.io/smaug6739/alexandrie-frontend:latest
    environment:
      - SERVICE_FQDN_FRONTEND_3000
  backend:
    image: ghcr.io/smaug6739/alexandrie-backend:latest
    environment:
      - SERVICE_FQDN_BACKEND_8201
    volumes:
      - alexandrie-uploads:/app/uploads
`),
  },
  appflowy: {
    slogan: 'Open source workspace with inline nginx config',
    category: 'productivity',
    tags: ['workspace', 'docs'],
    port: 80,
    compose: encodeCompose(`
services:
  nginx:
    image: nginx:alpine
    environment:
      - SERVICE_FQDN_APPFLOWY_80
    volumes:
      - type: bind
        source: ./nginx/nginx.conf
        target: /etc/nginx/nginx.conf
        content: |
          # nginx reverse proxy configuration
          events {}
          http { server { listen 80; } }
`),
  },
  anythingllm: {
    slogan: 'All-in-one AI app with host mount',
    category: 'ai',
    tags: ['ai', 'rag'],
    port: 3001,
    compose: encodeCompose(`
services:
  anythingllm:
    image: mintplexlabs/anythingllm:latest
    environment:
      - SERVICE_FQDN_ANYTHINGLLM_3001
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`),
  },
};

describe('Coolify Template Pack absent-pack graceful fallback', () => {
  it('returns an empty catalog when no local static template pack is installed', () => {
    const previousDir = process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    delete process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    clearCoolifyTemplateCatalogCache();
    try {
      const catalog = loadCoolifyTemplateCatalog();
      expect(catalog.size).toBe(0);
      const listing = listCoolifyTemplates({});
      expect(listing.total).toBe(0);
      expect(listing.items).toEqual([]);
      expect(listing.categories).toEqual([]);
      expect(getCoolifyTemplateDetail('n8n')).toBeUndefined();
    } finally {
      if (previousDir !== undefined) {
        process.env.MW_COOLIFY_TEMPLATE_PACK_DIR = previousDir;
      }
      clearCoolifyTemplateCatalogCache();
    }
  });
});

describe('Coolify Template Pack (fixture-backed catalog and compiler)', () => {
  let fixtureDir: string;
  let previousPackDir: string | undefined;

  beforeAll(() => {
    previousPackDir = process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'mw-coolify-pack-fixture-'));
    writeFileSync(
      path.join(fixtureDir, 'service-templates.json'),
      JSON.stringify(FIXTURE_TEMPLATES, null, 2),
      'utf8',
    );
    process.env.MW_COOLIFY_TEMPLATE_PACK_DIR = fixtureDir;
    clearCoolifyTemplateCatalogCache();
  });

  afterAll(() => {
    if (previousPackDir === undefined) {
      delete process.env.MW_COOLIFY_TEMPLATE_PACK_DIR;
    } else {
      process.env.MW_COOLIFY_TEMPLATE_PACK_DIR = previousPackDir;
    }
    clearCoolifyTemplateCatalogCache();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('loads catalog with zero unhandled parse errors', () => {
    const listing = listCoolifyTemplates({});
    expect(listing.total).toBe(Object.keys(FIXTURE_TEMPLATES).length);
    expect(listing.items.length).toBeGreaterThan(0);
    for (const templateSummary of listing.items) {
      expect(['ready', 'inline_config', 'restricted']).toContain(templateSummary.compatibility);
    }
  });

  it('provides paginated results with accurate total and categories', () => {
    const page1 = listCoolifyTemplates({ page: 1, limit: 3 });
    const page2 = listCoolifyTemplates({ page: 2, limit: 3 });
    expect(page1.total).toBe(page2.total);
    expect(page1.total).toBe(Object.keys(FIXTURE_TEMPLATES).length);
    expect(page1.categories.length).toBeGreaterThan(0);
    const page1Ids = new Set(page1.items.map((entry) => entry.id));
    const page2Ids = new Set(page2.items.map((entry) => entry.id));
    const overlap = [...page1Ids].filter((id) => page2Ids.has(id));
    expect(overlap.length).toBe(0);
  });

  const requiredTemplates = [
    'n8n',
    'uptime-kuma',
    'activepieces',
    'ghost',
    'affine',
    'alexandrie',
    'appflowy',
    'anythingllm',
  ];

  it('has detail entries for all required templates', () => {
    for (const id of requiredTemplates) {
      const detail = getCoolifyTemplateDetail(id);
      expect(detail).toBeDefined();
      expect(detail?.id).toBe(id);
      expect(typeof detail?.composeYaml).toBe('string');
      expect(detail?.composeYaml.length).toBeGreaterThan(0);
    }
  });

  const testTemplates: Array<{ id: string; expectedCompatibility: 'ready' | 'inline_config' | 'restricted' }> = [
    { id: 'n8n', expectedCompatibility: 'ready' },
    { id: 'uptime-kuma', expectedCompatibility: 'ready' },
    { id: 'activepieces', expectedCompatibility: 'ready' },
    { id: 'ghost', expectedCompatibility: 'ready' },
    { id: 'affine', expectedCompatibility: 'ready' },
    { id: 'alexandrie', expectedCompatibility: 'ready' },
    { id: 'appflowy', expectedCompatibility: 'inline_config' },
    { id: 'anythingllm', expectedCompatibility: 'restricted' },
  ];

  for (const { id, expectedCompatibility } of testTemplates) {
    it(`compiles ${id} (compatibility: ${expectedCompatibility})`, () => {
      const detail = getCoolifyTemplateDetail(id);
      expect(detail).toBeDefined();
      expect(detail?.compatibility).toBe(expectedCompatibility);

      if (expectedCompatibility === 'restricted') {
        return;
      }

      const compiled = compileCoolifyCompose({
        slug: id,
        tenantId: 'test-tenant',
        composeYaml: detail!.composeYaml,
        defaultPort: detail?.port ?? 8080,
        existingEnv: {},
        userEnv: {},
      });

      expect(compiled.composeYaml).toContain('mw-paas-');
      expect(compiled.composeYaml).toContain('moonwitness-paas');
      expect(compiled.files).toBeDefined();
      expect(compiled.env).toBeDefined();
      expect(compiled.primaryService).toBeDefined();
      expect(compiled.primaryPort).toBeGreaterThan(0);
      expect(compiled.ingressRoutes).toBeDefined();
    });
  }

  it('rejects anythingllm as restricted with clear error', () => {
    const detail = getCoolifyTemplateDetail('anythingllm');
    expect(detail).toBeDefined();
    expect(detail?.compatibility).toBe('restricted');
  });

  it('secret idempotency: activepieces compiles identically twice with existingEnv', () => {
    const detail = getCoolifyTemplateDetail('activepieces');
    expect(detail).toBeDefined();

    const run1 = compileCoolifyCompose({
      slug: 'activepieces',
      tenantId: 'test-tenant',
      composeYaml: detail!.composeYaml,
      defaultPort: detail?.port ?? 8080,
      existingEnv: {},
      userEnv: {},
    });

    const run2 = compileCoolifyCompose({
      slug: 'activepieces',
      tenantId: 'test-tenant',
      composeYaml: detail!.composeYaml,
      defaultPort: detail?.port ?? 8080,
      existingEnv: run1.env,
      userEnv: {},
    });

    expect(run2.env.SERVICE_PASSWORD_POSTGRES).toBe(run1.env.SERVICE_PASSWORD_POSTGRES);
    expect(run2.env.SERVICE_USER_POSTGRES).toBe(run1.env.SERVICE_USER_POSTGRES);
    for (const key of Object.keys(run1.env)) {
      if (key.startsWith('SERVICE_')) {
        expect(run2.env[key]).toBe(run1.env[key]);
      }
    }
  });

  it('rejects path-traversal inline file (../escape)', () => {
    const maliciousCompose = `
version: '3.8'
services:
  test:
    image: alpine
    volumes:
      - type: bind
        source: ../escape
        target: /tmp/escape
        content: "malicious"
`;
    expect(() =>
      compileCoolifyCompose({
        slug: 'malicious',
        tenantId: 'test-tenant',
        composeYaml: maliciousCompose,
        defaultPort: 8080,
        existingEnv: {},
        userEnv: {},
      }),
    ).toThrow(/path.traversal|invalid|escape|outside/u);
  });

  it('appflowy extracts ./nginx/nginx.conf into files', () => {
    const detail = getCoolifyTemplateDetail('appflowy');
    expect(detail).toBeDefined();

    const compiled = compileCoolifyCompose({
      slug: 'appflowy',
      tenantId: 'test-tenant',
      composeYaml: detail!.composeYaml,
      defaultPort: detail?.port ?? 8080,
      existingEnv: {},
      userEnv: {},
    });

    const nginxFileKey = Object.keys(compiled.files).find(
      (fileKey) => fileKey.includes('nginx') && fileKey.endsWith('.conf'),
    );
    expect(nginxFileKey).toBeDefined();
    expect(compiled.files[nginxFileKey!]).toContain('nginx');
  });

  it('alexandrie produces multiple ingress routes', () => {
    const detail = getCoolifyTemplateDetail('alexandrie');
    expect(detail).toBeDefined();

    const compiled = compileCoolifyCompose({
      slug: 'alexandrie',
      tenantId: 'test-tenant',
      composeYaml: detail!.composeYaml,
      defaultPort: detail?.port ?? 8080,
      existingEnv: {},
      userEnv: {},
    });

    expect(compiled.ingressRoutes.length).toBeGreaterThan(1);
    for (const route of compiled.ingressRoutes) {
      expect(route.service).toBeDefined();
      expect(route.host).toBeDefined();
      expect(route.url).toBeDefined();
      expect(route.port).toBeGreaterThan(0);
    }
  });

  it('affine removes exclude_from_hc', () => {
    const detail = getCoolifyTemplateDetail('affine');
    expect(detail).toBeDefined();

    const compiled = compileCoolifyCompose({
      slug: 'affine',
      tenantId: 'test-tenant',
      composeYaml: detail!.composeYaml,
      defaultPort: detail?.port ?? 8080,
      existingEnv: {},
      userEnv: {},
    });

    expect(compiled.composeYaml).not.toContain('exclude_from_hc');
  });
});
