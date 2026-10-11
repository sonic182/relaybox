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
Then open <http://localhost:3000/login> and sign in with it.

`API_KEY` is the only application credential. It is used by the dashboard login and by the
JSON API's `apikey` request header. Never commit `.env` or real credentials.

## What is exposed

### Dashboard

The dashboard lets you create, connect, rename, disconnect, and delete WhatsApp instances. It
also provides chat history, media, message sending, and webhook configuration.

### JSON API

All API routes require `apikey: YOUR_API_KEY`:

| Method | Path |
| --- | --- |
| POST | `/instance/create` |
| GET | `/instance/fetchInstances` |
| GET | `/instance/connectionState/{instanceName}` |
| GET | `/instance/connect/{instanceName}` |
| POST | `/instance/rename/{instanceName}` |
| POST | `/instance/disconnect/{instanceName}` |
| DELETE | `/instance/logout/{instanceName}` |
| DELETE | `/instance/delete/{instanceName}` |
| POST | `/message/sendText/{instanceName}` |
| POST | `/message/sendMedia/{instanceName}` |
| POST | `/message/sendWhatsAppAudio/{instanceName}` |
| POST | `/chat/findMessages/{instanceName}` |
| POST | `/chat/getBase64FromMediaMessage/{instanceName}` |
| POST | `/chat/updateMessage/{instanceName}` |
| POST | `/webhook/set/{instanceName}` |
| GET | `/webhook/find/{instanceName}` |
| POST | `/settings/set/{instanceName}` |
| GET | `/settings/find/{instanceName}` |

Interactive API documentation is public at `/redoc`. The OpenAPI source is available at
`/swagger.yml` and as JSON at `/swagger.json`.

### Webhooks

Webhook configuration is available in the dashboard and through the JSON API. The integration
guide is in [`docs/webhooks.md`](docs/webhooks.md).

### History sync

When a device is paired, WhatsApp sends its recent history. If the instance setting
`syncFullHistory` is on (it is off by default, set it at `POST /instance/create` or with
`POST /settings/set/{instanceName}`), the app stores those chats, contact names and messages, so
`list_chats` and `list_messages` also show conversations from before the pairing. Imported
messages are not published as webhooks and their media is not downloaded. WhatsApp only sends
this history while pairing, so an already paired instance needs `logout_instance` and a new QR
scan to receive it. See [`docs/history-sync.md`](docs/history-sync.md), including how this
differs from Evolution API.

### Remote control

A remote server can manage instances and webhooks over an outbound WebSocket when
`REMOTE_SERVER_URL` and `REMOTE_SERVER_TOKEN` are set. See
[`docs/ws-integration.md`](docs/ws-integration.md).

### MCP server

An authenticated [Model Context Protocol](https://modelcontextprotocol.io) server exposes the
JSON API, chat history, and media as tools. Enable it with `ENABLE_MCP_SERVER=true`; it is
mounted at `/mcp` (`MCP_PATH`) and authenticates with `Authorization: Bearer $API_KEY`.

```json
{
  "mcpServers": {
    "relaybox": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

For remote clients, set `MCP_ALLOWED_HOSTS` to the hostname (without scheme or port) that
clients use; unset means localhost-only and other Host headers receive **403**, even though
the app listens on all interfaces. Set `SERVER_URL` to the externally reachable HTTPS base
URL as well, or `get_media` will return localhost URLs. For example:

```dotenv
MCP_ALLOWED_HOSTS=wa.example.com
SERVER_URL=https://wa.example.com
```

`SERVER_URL` is also written into webhook envelopes. When the MCP client reaches the app by a
different address than webhook receivers do, such as a Docker hostname, set `MCP_MEDIA_BASE_URL`
to the address the MCP client uses; it only affects the signed links `get_media` returns and
defaults to `SERVER_URL`:

```dotenv
MCP_MEDIA_BASE_URL=http://relaybox:3000
```

The tools cover instance lifecycle, webhook configuration, sending text/media/voice notes,
message lookup and editing, chat history, and chat avatars. `send_media`/`send_audio` accept
either a URL or a small inline base64 payload (capped by `MCP_INLINE_MEDIA_BYTES`); `get_media`
returns a short-lived signed URL (`GET /media/{instanceName}/{keyId}`) that any caller can
fetch without the API key.

The separate `ENABLE_DEV_MCP` endpoint at `/dev/mcp` is local-only, unauthenticated, and
exposes `project_eval`; keep it disabled outside local development.

## Configuration

Copy `.env.example` to `.env` before starting the app:

| Variable | Description | Default |
| --- | --- | --- |
| `API_KEY` | Dashboard and API credential, at least 16 characters (`openssl rand -hex 32`) | required |
| `DB_URL` | PostgreSQL connection string | required |
| `PORT` | HTTP port | `3000` |
| `SERVER_URL` | Public URL written into webhook envelopes | `http://localhost:$PORT` |
| `DELIVERY_CONCURRENCY` | Concurrent webhook deliveries | `4` |
| `MAX_OUTBOUND_MEDIA_BYTES` | Largest outbound media file, fetched from a URL or decoded from base64 | `20971520` |
| `LOG_LEVEL` | Minimum log level | `info` |
| `LOG_FORMAT` | Console log format | `logfmt` |
| `LOG_DIRECTORY` | Optional directory for JSON application logs | unset |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | Permit webhook callbacks on the local network, over plain http | `false` |
| `REMOTE_SERVER_URL` | Outbound `wss://` URL for remote control (`ws://` only for loopback/private hosts) | unset |
| `REMOTE_SERVER_TOKEN` | Bearer token sent to `REMOTE_SERVER_URL`; required when it is set | unset |
| `ENABLE_DEV_MCP` | Enable the unauthenticated local development MCP endpoint at `/dev/mcp` | `false` |
| `ENABLE_MCP_SERVER` | Enable the authenticated MCP server | `false` |
| `MCP_PATH` | Non-root literal MCP mount path (no trailing slash; outside existing HTTP route namespaces) | `/mcp` |
| `MCP_ALLOWED_HOSTS` | Allowed Host/Origin hostnames (no scheme or port); unset restricts MCP to localhost | unset |
| `MCP_INLINE_MEDIA_BYTES` | Largest inline base64 media payload MCP tools accept or return (`0` disables) | `1048576` |
| `MCP_MEDIA_BASE_URL` | Base URL of the signed media links MCP tools return | `SERVER_URL` |
| `MCP_MEDIA_URL_TTL` | Lifetime of a signed media URL, in seconds | `300` |

In production, webhook URLs must use HTTPS except for loopback addresses.

Set `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` when the consumer runs on your LAN — an automation
host at `http://192.168.1.50:5678/webhook`, say. It permits RFC 1918 and IPv6 unique-local
addresses plus `.local` and `.internal` names, over http, at both configuration time and
delivery time. Link-local (`169.254.0.0/16`, including cloud instance metadata) stays blocked,
and public hosts still require HTTPS. Leave it off on a deployment reachable by anyone you
would not trust with the network it sits in: the guard is what stops a stolen `API_KEY` from
pointing the server at internal services.

Keep `ENABLE_DEV_MCP=false`; that endpoint permits arbitrary project evaluation and is not an
API. The `ENABLE_MCP_SERVER` endpoint is separate: it requires the `API_KEY` as a Bearer token
and never exposes arbitrary code execution.

## Development commands

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

## Security

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability and for deployment guidance.

## License

[MIT](LICENSE)
