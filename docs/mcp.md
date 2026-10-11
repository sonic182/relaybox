# MCP server

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

## Remote clients

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

## Tools

The tools cover instance lifecycle, webhook configuration, sending text/media/voice notes,
message lookup and editing, chat history, and chat avatars. `send_media`/`send_audio` accept
either a URL or a small inline base64 payload (capped by `MCP_INLINE_MEDIA_BYTES`); `get_media`
returns a short-lived signed URL (`GET /media/{instanceName}/{keyId}`) that any caller can
fetch without the API key.

## Development endpoint

The separate `ENABLE_DEV_MCP` endpoint at `/dev/mcp` is unauthenticated and exposes
`project_eval`. It only accepts connections whose peer address is loopback, so it is not
reachable from the network, nor through Docker port publishing (run `pnpm run dev` on the
host to use it); keep it disabled outside local development. It permits arbitrary
project evaluation and is not an API. The `ENABLE_MCP_SERVER` endpoint is separate: it
requires the `API_KEY` as a Bearer token and never exposes arbitrary code execution.

All MCP variables are listed in [`configuration.md`](configuration.md).
