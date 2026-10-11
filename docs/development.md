# Development

## Commands

- `pnpm run dev` — watch TypeScript and Tailwind, serving on port 3000
- `pnpm run build` — compile CSS and TypeScript
- `pnpm start` — run the compiled app
- `pnpm run zen:generate` — regenerate the ZenStack client
- `pnpm run zen:migrate` — create and apply a migration
- `pnpm run zen:deploy` — apply committed migrations
- `pnpm run lint` — lint source and tests
- `pnpm run typecheck` — typecheck source and tests
- `pnpm test` — run the full test suite once
- `pnpm run test:unit` — run unit tests
- `pnpm run test:integration` — run HTTP integration tests

## Project layout

- `src/index.ts` — runtime bootstrap and background workers
- `src/app.ts` — testable Express app composition
- `src/api/` — Evolution-compatible JSON API
- `src/mcp/` — authenticated MCP server and its tools
- `src/controllers/` — dashboard and HTTP adapters
- `src/contracts/evolution.ts` — API and webhook contract shapes
- `src/instances.ts`, `src/messages.ts`, `src/webhooks.ts` — domain services
- `zenstack/` — database schema and migrations
- `tests/` — unit and integration tests
