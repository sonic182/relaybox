# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Updated vulnerable dependencies: `proxy-addr` 2.0.8 (IP spoofing through IPv4-mapped IPv6 trusted subnets, which `TRUST_PROXY` relies on), `hono` 4.13.7 (unescaped strings in hono/jsx), `music-metadata` 11.16.1, `brace-expansion` 5.0.12, `sharp` 0.35.5 (librsvg) and `source-map-js` 1.2.2. `sharp` and `source-map-js` come in through other packages, so `pnpm-workspace.yaml` pins them with `overrides`.

## [0.2.0] 2026-10-11

### Security
- Inbound media is stored under a random file name instead of the sender-chosen message id, which allowed writing outside the media directory or overwriting another chat's file.
- The development MCP endpoint (`ENABLE_DEV_MCP`) only accepts loopback connections, and the `relaybox-dev` compose service binds to `127.0.0.1`. It no longer works through Docker port publishing; run `pnpm run dev` on the host to use it.
- Cookie-authenticated dashboard POSTs (including login and logout) are rejected when `Sec-Fetch-Site` or `Origin` shows a cross-site request (403). The proxy must pass the original `Host` header for the `Origin` fallback used by browsers without `Sec-Fetch-Site`.
- `POST /login` is limited to 10 attempts per minute per client, and signed media downloads to 120. New `TRUST_PROXY` setting (prefer a hop count such as `1`) so limits apply per client behind a reverse proxy.
- Dashboard sessions expire after `SESSION_TTL_SECONDS` (default 7 days). Existing sessions are signed out once on upgrade.
- Security relaxations (insecure webhook URLs, non-`Secure` session cookie, `/ui`, the dev MCP, Express stack traces) now require `NODE_ENV=development` or `test`; any other value, or unset, is strict, so the dashboard then needs HTTPS (or `localhost`) for its `Secure` session cookie. `pnpm run dev` sets `development` itself.
- Loopback webhook targets (`localhost`, `127.0.0.0/8`, `::1`, `*.localhost`) are refused unless `ALLOW_PRIVATE_WEBHOOK_TARGETS=true`, and `*.localhost` names are resolved and checked at delivery. At startup the app logs a warning for each enabled webhook whose stored URL the policy now rejects.
- CDN scripts (htmx, qrcode-generator, Redoc) are pinned to exact versions with Subresource Integrity, and pages send a Content-Security-Policy, `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy`.
- Delivered and failed webhook deliveries have their payload cleared after `DELIVERY_RETENTION_DAYS` (default 7); the row and its dedupe key stay, so a replayed event is still not re-sent, and so do its callback URL and last error (only the payload is cleared). Migration: `WebhookDelivery.payload` becomes nullable and gains a `(status, createdAt)` index; open event streams are capped at 50 across all dashboard tabs (503 beyond); a send `delay` is capped at 300000 ms (400 beyond); the JSON API checks the `apikey` before parsing request bodies.
- `MCP_READ_ONLY` and `MCP_TOOLS` limit the MCP tools (an unknown name, or a combination that leaves none, stops startup), so an agent reading untrusted chats need not hold send or delete tools.
- Voice notes are transcoded by the system ffmpeg (`FFMPEG_PATH`, default `ffmpeg` on `PATH`) instead of the bundled 2018 build, with protocol and input-format whitelists. Local installs need ffmpeg on `PATH`; the Docker image includes it.
- The Docker image runs as the `node` user. Existing root-owned volumes need one fix: `docker compose run --rm --user root --entrypoint chown relaybox -R node:node /app/media /app/sessions`.

## [0.1.0] 2026-10-11

First tagged release.

### Added
- Dashboard to create, connect, rename, disconnect and delete WhatsApp instances, with chat history, media, message sending and webhook configuration.
- Evolution-compatible JSON API (reference 2.4.0 shapes) for instances, messages, chats, webhooks and settings, authenticated with the `apikey` header. OpenAPI spec served at `/redoc` and `/swagger.json`.
- Outbound webhooks, optionally signed.
- History sync of the chats WhatsApp sends while pairing, off by default.
- Remote control over an outbound WebSocket.
- MCP server exposing the API, chat history and media as tools.
- PostgreSQL persistence through ZenStack, with committed migrations.
- Dockerfile and `docker-compose.yml` setup.

[Unreleased]: https://github.com/sonic182/relaybox/compare/0.2.0...HEAD
[0.2.0]: https://github.com/sonic182/relaybox/compare/0.1.0..0.2.0
[0.1.0]: https://github.com/sonic182/relaybox/compare/b3c72c1..0.1.0
