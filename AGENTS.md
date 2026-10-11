# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. `src/app.ts` is the composition root: it configures Express middleware and mounts controllers without opening a port. `src/index.ts` is the runtime bootstrap; create shared runtime services there, pass them to `createApp()`, and start background restoration there. Keep request authentication in `src/auth.ts`, configuration validation in `src/config.ts`, page markup in `src/views.tsx`, and reusable JSX components in `src/components.tsx`. Tailwind source is `src/styles.css`, compiled to `public/styles.css`.

The OpenAPI spec is `public/swagger.yml`, and it is the only one: `src/controllers/documentation.ts` reads it to serve `/redoc` and `/swagger.json`, caching it on first read. It documents what is actually mounted, so adding, changing, or removing an endpoint or a request/response field means editing it in the same change.

Use the small MVC-inspired boundary already in the application:

- `src/controllers/` contains thin HTTP adapters. Controllers validate/request-map input, call a service, and select status codes, redirects, headers, or rendered fragments.
- `src/api/` is the Evolution-compatible JSON API: `router.ts` mounts it on the prefixes in `API_PREFIXES`, `auth.ts` checks the `apikey` header, and `errors.ts` maps thrown `ApiError`s to the reference error envelope. It shares services with the HTML controllers and never renders markup.
- `src/contracts/evolution.ts` is the only place Evolution API shapes are encoded (event names, request/response types, envelope and error builders). Never import from `./evolution-api` at runtime; JSON fixtures in `tests/fixtures/evolution/` pin the shapes.
- Domain services such as `src/instances.ts` and `src/webhooks.ts` own business state and external I/O (Baileys, filesystem, and eventually persistence). They must not import Express, controllers, or views.
- Views receive plain DTOs/snapshots and render markup; they must not access services or sockets.
- `src/app.ts` wires controllers to routes and auth middleware only. Do not put domain logic or response rendering there.

Prefer factory functions and explicit dependency injection over global mutable state: for example, `createInstanceService()` creates a service and `createInstancesController(service)` adapts it to HTTP. Define small service interfaces at this boundary so tests can inject fakes. Services may expose typed domain events through `subscribe()`; future message ingestion, database persistence, SSE, or webhooks should consume those events rather than coupling Baileys callbacks directly to HTTP handlers.

Tests mirror the area under test: use `tests/unit/` for isolated logic and `tests/integration/` for HTTP behavior. Shared test setup belongs in `tests/setup.ts`. ZenStack’s schema and generated database artifacts are rooted in `zenstack/`.

## Build, Test, and Development Commands

- `pnpm install` installs dependencies.
- `pnpm run dev` watches TypeScript and Tailwind, serving the app on port 3000. Its watcher restarts on changes to files it has already imported, so **restart it after adding a new module or editing `.env`** — otherwise the running server silently serves stale code.
- `pnpm run build` compiles CSS and TypeScript into `public/` and `dist/`; `pnpm start` runs the build.
- `pnpm run typecheck` type-checks `tests/` too (via `tsconfig.test.json`), which `pnpm run build`'s `tsc` does not reach since tests must not leak into `dist/`. CI runs it as its own step — run it locally whenever a change touches a shared type (e.g. `InstanceService`) so a test fixture missing a new method surfaces before CI does.
- `pnpm run zen:generate` regenerates ZenStack client code after changing `zenstack/schema.zmodel`; `pnpm run zen:migrate` creates and applies a migration; `pnpm run zen:deploy` applies committed migrations. Commit `zenstack/migrations/`.
- `pnpm test` (or `pnpm run test:run`) runs all tests once and exits. Use `pnpm run test:unit`, `pnpm run test:integration`, or `pnpm run test:coverage` when focused feedback or coverage is needed.
- Tests need PostgreSQL. `make test-file FILE="tests/unit/instances.test.ts"` (or `make test`) starts the throwaway database in `docker-compose.test.yml` on `127.0.0.1:55432` (override with `TEST_DB_PORT`) and points `DB_URL` at it, overriding `.env`; `make test-db-down` removes it. Pass `PNPM="corepack pnpm"` when `pnpm` is not on `PATH`.
- Agents: don't run the full suite (`make test` / `pnpm test` / `pnpm run test:run` / `pnpm run test:coverage`) locally — CI runs it on push. Locally, run `pnpm run typecheck`, `pnpm run lint`, `pnpm run jscpd`, and only the test file(s) touched by the change (e.g. `make test-file FILE="tests/unit/instances.test.ts"`).
- `pnpm run dev` and `pnpm run test:watch` never exit. Run them only in an interactive terminal you intend to keep open; from a script, CI step, or agent session, use the one-shot script instead. Every other script in `package.json` terminates. When adding a script, default it to a form that exits and give the long-running variant a `:watch` suffix.

Set `API_KEY` and `DB_URL` in the environment or `.env` before starting the application. `API_KEY` is the single credential: the dashboard login stores an HMAC derived from it in the httpOnly `relaybox_session` cookie, and the JSON API reads it from the `apikey` header. Never commit real keys or generated local database files.

## Coding Style & Naming Conventions

Write strict TypeScript with two-space indentation, single quotes, and semicolons, matching existing files (enforced by `@stylistic/eslint-plugin` in `eslint.config.mts`). Prefer named exports and concise focused functions. Use camelCase for functions and variables, PascalCase for types/components, and `*.test.ts` for tests. Keep `src/app.ts` side-effect free except for app setup so integration tests can import `createApp()` without opening a port.

Preserve surrounding formatting. Run `pnpm run lint`, `pnpm run build`, and `pnpm run typecheck` before submitting TypeScript changes.

## Testing Guidelines

Use Vitest with `describe`/`it`/`expect`; HTTP routes should use Supertest against `createApp()`. For controller behavior that depends on a domain service, inject `createFakeInstanceService()` from `tests/helpers.ts` rather than starting Baileys or touching session files. For database behavior use `createTestDb()` from the same file: it uses the migrated, isolated PostgreSQL test database, which keeps production constraints in play. Add unit tests for validation, service/event behavior, or utility branches, and integration tests for redirects, cookies, status codes, rendered responses, and controller-to-service calls. The coverage configuration includes `src/**/*.ts` except the runtime bootstrap, database module, and declarations.

## Commit & Pull Request Guidelines

History uses brief lowercase subjects (for example, `basic login`). Write an imperative, scoped summary and keep each commit cohesive. Pull requests should explain the user-visible change, list commands run, link relevant issues, and include screenshots for UI changes. Call out schema, environment-variable, or migration effects explicitly.
