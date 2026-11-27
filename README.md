# mw-dock — Modular backend-as-a-service runtime for MoonWitness.

**Repository:** [`A-L-L-A-H/mw-dock`](https://github.com/A-L-L-A-H/mw-dock) · **Stack:** TypeScript · Bun · Fastify · SQLite/PostgreSQL

## What it does

Exposes dynamic REST CRUD and JSON-RPC through a composable ORM, auth/RBAC, jobs/outbox, and domain addons.

## Quick start

```bash
bun install
bun --filter @moonwitness/types build
bun --filter @moonwitness/api build
bun run start
```

## Verify

```bash
bun run build
bun --filter @moonwitness/api test
```

## Configuration

- **Port:** 3000
- **Key configuration:** DATABASE_URL for PostgreSQL

```bash
docker build -t ghcr.io/a-l-l-a-h/mw-dock:latest .
```

## Notes

Local development uses embedded SQLite. Set DATABASE_URL and run bun run db:migrate for PostgreSQL. Workers: bun run jobs:worker, bun run jobs:scheduler, bun run jobs:outbox.
