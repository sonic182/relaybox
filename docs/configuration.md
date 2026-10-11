# Configuration

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

`API_KEY` is the only application credential. It is used by the dashboard login and by the
JSON API's `apikey` request header. Never commit `.env` or real credentials.

## Webhook targets

In production, webhook URLs must use HTTPS except for loopback addresses.

Set `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` when the consumer runs on your LAN — an automation
host at `http://192.168.1.50:5678/webhook`, say. It permits RFC 1918 and IPv6 unique-local
addresses plus `.local` and `.internal` names, over http, at both configuration time and
delivery time. Link-local (`169.254.0.0/16`, including cloud instance metadata) stays blocked,
and public hosts still require HTTPS. Leave it off on a deployment reachable by anyone you
would not trust with the network it sits in: the guard is what stops a stolen `API_KEY` from
pointing the server at internal services.

## MCP

Keep `ENABLE_DEV_MCP=false`; that endpoint permits arbitrary project evaluation and is not an
API. See [`mcp.md`](mcp.md) for the authenticated MCP server.
