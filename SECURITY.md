# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through
GitHub's [private vulnerability reporting](../../security/advisories/new) for this repository,
with steps to reproduce and the affected version or commit. You should get a first response
within a week.

Only the latest commit on `main` receives fixes.

## Deployment guidance

A running instance holds live WhatsApp sessions, so anyone with its `API_KEY` or its database
can read and send messages as the paired numbers.

- Use a random `API_KEY` of at least 16 characters (`openssl rand -hex 32`); the app refuses
  shorter keys and the `.env.example` placeholder. Rotating it also signs out every dashboard
  session.
- Serve the app behind an HTTPS reverse proxy with `NODE_ENV=production`, so the dashboard
  cookie is marked `Secure` and webhook targets must use HTTPS. Set `TRUST_PROXY` so the
  built-in login rate limit applies per client. The app does not rate-limit API-key or MCP
  requests; do that at the proxy if the app is reachable from the internet.
- Treat the PostgreSQL database, its backups, and the `media` volume as secrets: they contain
  the Baileys session credentials, message history, and downloaded media.
- Keep `ENABLE_DEV_MCP` off. It exposes unauthenticated arbitrary code execution and is meant
  only for local development.
- Leave `ALLOW_PRIVATE_WEBHOOK_TARGETS` off unless webhook consumers really live on this host or
  your LAN. Without it, a leaked `API_KEY` cannot point webhooks at loopback or internal services.
