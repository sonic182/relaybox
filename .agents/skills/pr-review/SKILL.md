---
name: pr-review
description: "Review TypeScript/Express pull requests in this project for behavioral regressions, API contract drift, security, persistence, and test gaps."
---

# PR Review

Review the committed pull-request diff for this TypeScript/Express + ZenStack application. Focus on behavioral impact and actionable findings, not style-only comments. Do not edit code unless the user separately asks for fixes.

## Scope and context

Use this skill for a review request involving this repository's TypeScript application. It is especially relevant when a change touches HTTP routes, the Evolution-compatible API, authentication, instance lifecycle, webhooks, ZenStack persistence, or rendered dashboard pages.

Do not use it for a Python-specific review, a pure formatting-only change, or a request to implement a feature rather than assess one.

Key boundaries to preserve while reviewing:

- `src/app.ts` wires middleware and routes but does not own domain logic.
- `src/controllers/` adapts HTML/htmx requests; `src/api/` adapts Evolution-compatible JSON requests. Both should delegate to services.
- `src/contracts/evolution.ts` is the source of truth for supported Evolution API shapes. JSON fixtures in `tests/fixtures/evolution/` pin externally visible behavior.
- Domain services such as `src/instances.ts` and `src/webhooks.ts` own state, Baileys I/O, filesystem access, and persistence; they do not import Express or views.
- `src/views.tsx` and `src/components.tsx` render plain DTOs only. They must not access services, sockets, or secrets.
- ZenStack schema and committed migrations live under `zenstack/`; tests can use the migrated in-memory SQLite database from `tests/helpers.ts`.

## Review workflow

1. Establish the exact committed comparison range. Prefer an up-to-date remote base (`origin/main` unless the PR declares another base). Fetch only when allowed; if it cannot be refreshed, state that the review uses the locally recorded base.
2. Review only `git diff <base>...HEAD`. Check `git status --short`, but do not include unstaged or uncommitted changes in conclusions.
3. When available, inspect PR title, body, comments, base, and head with `gh pr view`. Read linked issues only when they materially clarify intended behavior.
4. Map touched modules before judging the diff: request entry point, validation/auth, service calls, persistence/external I/O, rendered/API response, error handling, and tests.
5. Search code structurally with `ast-grep` before text search. Use it to trace callers, imports, route registration, service methods, error paths, and persistence operations.
6. Run the relevant repository checks when permissions permit: `npm run lint`, `npm run build`, and `npm test` (or `npm run test:unit` / `npm run test:integration`). Never run `npm run dev` or `npm run test:watch` — they do not exit. Supertest integration tests need local socket binding; report an environment restriction distinctly from a test failure.

## What to inspect

### HTTP, API, and contracts

- Trace a new route from `src/app.ts` or `src/api/router.ts` through its controller/router into the service and response/error mapper.
- Confirm protected HTML routes use dashboard authentication and JSON API routes use `apikey` authentication. Do not assume a browser cookie authenticates an API call.
- Check status codes, redirect/htmx headers, content type, API error envelopes, malformed request handling, and unknown-resource behavior.
- Compare request/response types in `src/contracts/evolution.ts`, OpenAPI entries in `public/swagger.yml`, fixtures, and runtime validation. Flag documented or typed inputs that the runtime rejects, and runtime behavior that clients cannot express.
- Verify rendered strings and attributes cannot expose webhook headers, API keys, session values, raw message payloads, or unescaped user-controlled content.

### Domain state, persistence, and lifecycle

- For instance and webhook changes, distinguish an unknown instance from an existing but unconfigured instance whenever the UI needs different behavior, even if an Evolution API intentionally returns the same `null` response.
- Check ZenStack queries, unique constraints, cascades, migrations, JSON null handling, update races, and error mapping. A read-before-write sequence can race with instance deletion or another request.
- Ensure a change has the intended idempotency behavior, especially for `upsert`, message keys, and future delivery/outbox rows.
- For Baileys or background work, inspect socket ownership, listener cleanup, retry/cancellation behavior, duplicate events, blocking work, and process-restart recovery. HTTP handlers must not couple directly to Baileys callbacks.

### Security and reliability

- Treat callback URLs as an SSRF boundary. Validate protocol, private/link-local and loopback policies, redirects, DNS resolution/rebinding, timeouts, and the final connected address where delivery code exists. A configuration-time hostname check alone does not secure a delivery worker.
- Check secrets are not logged or returned beyond intentional reference compatibility, and that configuration forms do not round-trip secret values.
- Check authorization on every read and write path, cookie attributes, CSRF exposure for cookie-authenticated mutations, input limits, and failure paths that leak driver errors or stack traces.
- Check production configuration defaults, environment-variable changes, deployment/credential migration notes, and compatibility of database changes during rollout.

### Tests and documentation

- Require focused tests for new validation branches, authorization failures, unknown-instance behavior, API error bodies, and service state transitions where the diff changes them.
- For persistence, favor `createTestDb()` over hand-written fakes when constraints or migrations are part of the behavior.
- Flag missing updates to `README.md`, `docs/internal/roadmap.md`, or `public/swagger.yml` only when a user-visible endpoint, credential, environment setting, or deployment expectation changed.

## Required review output

Use this exact structure:

1. **Summary** — what changed, the comparison range, and `ship`, `needs work`, or `blocked`.
2. **Critical Issues** — release-blocking correctness, security, data-loss, or authorization findings. Say `None` when empty.
3. **Major Concerns** — material behavior, compatibility, reliability, or test-coverage gaps. Say `None` when empty.
4. **Minor Suggestions** — lower-risk maintainability, documentation, or defensive improvements. Say `None` when empty.
5. **Positive Highlights** — concrete things the diff does well.
6. **Questions** — only questions genuinely needed to determine correctness.

For every issue provide:

- severity: `critical`, `major`, or `minor`;
- exact `path/to/file.ts:line` anchor when available, otherwise the nearest function, route, class, or schema;
- the faulty behavior and realistic impact;
- a concrete fix direction; and
- a test to add when it would prevent recurrence.

Do not invent line numbers, turn hypothetical future work into a current defect without an execution path, or report style preferences as bugs. Clearly label unverified assumptions and any inability to refresh refs or execute tests.
