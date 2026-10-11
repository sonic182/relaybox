# Configuration

Copy `.env.example` to `.env` before starting the app:

| Variable | Description | Default |
| --- | --- | --- |
| `API_KEY` | Dashboard and API credential, at least 16 characters (`openssl rand -hex 32`) | required |
| `DB_URL` | PostgreSQL connection string | required |
| `NODE_ENV` | `development` or `test` relaxes webhook URL checks, the session cookie's `Secure` flag, and enables `/ui` and `ENABLE_DEV_MCP`; anything else, including unset, is strict. `pnpm run dev` sets `development` | unset (strict) |
| `PORT` | HTTP port | `3000` |
| `SERVER_URL` | Public URL written into webhook envelopes | `http://localhost:$PORT` |
| `DELIVERY_CONCURRENCY` | Concurrent webhook deliveries | `4` |
| `DELIVERY_RETENTION_DAYS` | Days to keep delivered and failed webhook delivery rows; pruned daily | `7` |
| `MAX_OUTBOUND_MEDIA_BYTES` | Largest outbound media file, fetched from a URL or decoded from base64 | `20971520` |
| `LOG_LEVEL` | Minimum log level | `info` |
| `LOG_FORMAT` | Console log format | `logfmt` |
| `LOG_DIRECTORY` | Optional directory for JSON application logs | unset |
| `SESSION_TTL_SECONDS` | How long a dashboard login stays valid; rotating `API_KEY` revokes every session | `604800` (7 days) |
| `TRUST_PROXY` | Express `trust proxy` behind a reverse proxy (`true`, a hop count, or addresses); login and media rate limits then key on the client address | unset |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | Permit webhook callbacks on this host (loopback) or the local network, over plain http | `false` |
| `REMOTE_SERVER_URL` | Outbound `wss://` URL for remote control (`ws://` only for loopback/private hosts) | unset |
| `REMOTE_SERVER_TOKEN` | Bearer token sent to `REMOTE_SERVER_URL`; required when it is set | unset |
| `ENABLE_DEV_MCP` | Enable the unauthenticated development MCP endpoint at `/dev/mcp` (loopback connections only) | `false` |
| `ENABLE_MCP_SERVER` | Enable the authenticated MCP server | `false` |
| `MCP_PATH` | Non-root literal MCP mount path (no trailing slash; outside existing HTTP route namespaces) | `/mcp` |
| `MCP_ALLOWED_HOSTS` | Allowed Host/Origin hostnames (no scheme or port); unset restricts MCP to localhost | unset |
| `MCP_INLINE_MEDIA_BYTES` | Largest inline base64 media payload MCP tools accept or return (`0` disables) | `1048576` |
| `MCP_MEDIA_BASE_URL` | Base URL of the signed media links MCP tools return | `SERVER_URL` |
| `MCP_MEDIA_URL_TTL` | Lifetime of a signed media URL, in seconds | `300` |

`API_KEY` is the only application credential. It is used by the dashboard login and by the
JSON API's `apikey` request header. Never commit `.env` or real credentials.

## Webhook targets

Unless `NODE_ENV` is `development` or `test`, webhook URLs must use HTTPS and must not target
this host (loopback) or the local network.

Set `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` when the consumer runs on your LAN — an automation
host at `http://192.168.1.50:5678/webhook`, say. It permits loopback, RFC 1918 and IPv6
unique-local addresses plus `.localhost`, `.local` and `.internal` names, over http, at both configuration time and
delivery time. Link-local (`169.254.0.0/16`, including cloud instance metadata) stays blocked,
and public hosts still require HTTPS. Leave it off on a deployment reachable by anyone you
would not trust with the network it sits in: the guard is what stops a stolen `API_KEY` from
pointing the server at internal services.

## MCP

Keep `ENABLE_DEV_MCP=false`; that endpoint permits arbitrary project evaluation and is not an
API. See [`mcp.md`](mcp.md) for the authenticated MCP server.
