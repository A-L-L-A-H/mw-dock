# MoonWitness Dock (`mw-dock`)

Modular Backend-as-a-Service (BaaS) combining a dynamic ORM, composable Core & Vertical Addons, automatic REST CRUD & JSON-RPC endpoints, Auth/RBAC, background Jobs/Outbox workers, and the `@moonwitness/client` TypeScript SDK.

## Architecture

- **API Runtime (`@moonwitness/api`)**: Fastify 5 service exposing dynamic REST CRUD, JSON-RPC 2.0, OpenAPI/Swagger, multipart attachments, and rate limiting on `:3000`.
- **Dynamic ORM (`@moonwitness/orm`)**: Objection.js + Knex registry with runtime schema introspection, migrations, hooks, and addon composition.
- **Auth & RBAC (`@moonwitness/auth`)**: JWT sessions, role-based access control, superadmin management, and session revocation.
- **Jobs & Outbox (`@moonwitness/jobs`)**: Durable background job worker, cron scheduler, and transactional outbox processor.
- **Dynamic Addons (`@moonwitness/orm-*`)**: Modular domain packs (`orm-base`, `orm-organization`, `orm-project`, `orm-crm`, `orm-sales`, `orm-subscription`, `orm-workflow`, `orm-notification`, `orm-storage`, `orm-whatsapp`, `orm-integration`, `orm-knowledge`, `orm-request`, `orm-isp`, `orm-cloud`, `orm-ai`, `orm-a2a`, `orm-observability`).
- **TypeScript SDK (`@moonwitness/client`)**: Typed client for REST CRUD, JSON-RPC, and auth flows.

## Quick Start

```bash
bun install
bun --filter @moonwitness/types build
bun --filter @moonwitness/api build
bun run start
```

## Database Modes

- **SQLite (Local / Embedded)**: Zero-config file-backed SQLite via `better-sqlite3` (default for local development).
- **PostgreSQL (Production)**: Set `DATABASE_URL=postgres://user:pass@host:5432/db` and run migrations:

```bash
bun run db:migrate
```

## CLI Commands

| Command | Description |
| --- | --- |
| `bun run build` | Build all workspace packages |
| `bun run api:build` | Build `@moonwitness/api` |
| `bun run dev` | Start API in watch mode |
| `bun run start` | Start compiled API server (`:3000`) |
| `bun run db:migrate` | Run database migrations |
| `bun run jobs:worker` | Start background jobs worker |
| `bun run jobs:scheduler` | Start cron jobs scheduler |
| `bun run jobs:outbox` | Start transactional outbox worker |
| `bun run reset:superadmin-password` | Reset superadmin password |
| `bun run revoke:auth-sessions` | Revoke active auth sessions |
| `bun run attachments:reconcile` | Reconcile storage attachments |

## API Surfaces

- **REST CRUD**: `/api/v1/<model>` (`GET`, `POST`, `PATCH`, `DELETE`) with filtering, pagination, and relation expansion.
- **JSON-RPC 2.0**: `/rpc` for typed model actions and batch operations.
- **OpenAPI / Swagger**: `/docs` interactive API specification.
- **Healthcheck**: `/health` liveness endpoint.

## TypeScript SDK (`@moonwitness/client`)

```ts
import { createClient } from "@moonwitness/client";

const client = createClient({
  baseUrl: "http://localhost:3000",
  token: process.env.MW_API_TOKEN,
});
```

## Docker

```bash
docker build -t ghcr.io/a-l-l-a-h/mw-dock:latest .
docker run -p 3000:3000 -e DATABASE_URL=postgres://... ghcr.io/a-l-l-a-h/mw-dock:latest
```
