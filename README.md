# Relaybox

Self-hosted WhatsApp bridge with a dashboard, an Evolution-compatible JSON API, and outbound
webhooks. It uses Baileys for WhatsApp connections and PostgreSQL for application state.

> [!WARNING]
> This is an unofficial project. It connects through [Baileys](https://github.com/WhiskeySockets/Baileys),
> an unofficial WhatsApp Web client, not the WhatsApp Business API. Automated use can violate
> WhatsApp's terms of service and get a number banned; use it at your own risk. It is not
> affiliated with or endorsed by WhatsApp, Meta, or the [Evolution API](https://github.com/EvolutionAPI/evolution-api)
> project, whose API shapes it reproduces. It currently depends on a patched Baileys release
> candidate (`patches/baileys@7.0.0-rc14.patch`).

## Requirements

- Node.js 24+
- pnpm 11+
- Docker, for the local PostgreSQL database

## Quick start

```bash
pnpm install
docker compose up -d postgres
cp .env.example .env
pnpm run zen:deploy
pnpm run dev
```

Replace the placeholder `API_KEY` in `.env` with a random value of at least 16 characters (for
example `openssl rand -hex 32`); the app refuses to start with a shorter key or the placeholder.
Then open <http://localhost:3000/login> and sign in with it. The interactive API reference is
at <http://localhost:3000/redoc>.

`API_KEY` is the only application credential, used by the dashboard login and by the JSON
API's `apikey` header. Never commit `.env` or real credentials. All other settings are in
[`docs/configuration.md`](docs/configuration.md).

## Features

- **Dashboard** to create, connect, rename, disconnect and delete WhatsApp instances, with
  chat history, media, message sending and webhook configuration.
- **Evolution-compatible JSON API** for instances, messages, chats, webhooks and settings.
  See [`docs/api.md`](docs/api.md), or the interactive reference at `/redoc`.
- **Outbound webhooks**, optionally signed. See [`docs/webhooks.md`](docs/webhooks.md).
- **History sync** of the chats WhatsApp sends while pairing, off by default. See
  [`docs/history-sync.md`](docs/history-sync.md).
- **Remote control** over an outbound WebSocket. See
  [`docs/ws-integration.md`](docs/ws-integration.md).
- **MCP server** exposing the API, chat history and media as tools. See
  [`docs/mcp.md`](docs/mcp.md).

## Documentation

- [Configuration](docs/configuration.md): environment variables and webhook target rules
- [Development](docs/development.md): commands and project layout

## Security

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability and for deployment guidance.

## License

[MIT](LICENSE)
