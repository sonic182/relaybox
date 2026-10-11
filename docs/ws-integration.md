# Remote control over WebSocket

Relaybox can be managed by a remote server through one outbound WebSocket connection.
Relaybox dials the remote server; it exposes no inbound WebSocket route and needs no
reachable port. The remote server can manage instance lifecycle and webhook settings.
Message and chat operations are not available over the socket.

## Setup

Set both variables and restart the server:

| Variable | Description |
| --- | --- |
| `REMOTE_SERVER_URL` | URL Relaybox connects to, for example `wss://control.example/relaybox` |
| `REMOTE_SERVER_TOKEN` | Bearer token sent on the connection; required when the URL is set |

- Use `wss://`. Plain `ws://` is accepted only for loopback hosts (`localhost`, `127.0.0.0/8`,
  `::1`), literal private IP addresses, and `*.local` / `*.internal` names. Other hostnames,
  including container service names, need `wss://`.
- The URL must not contain credentials (`user:pass@`) or a fragment (`#...`). The token is
  the only credential.
- An invalid combination logs an error and disables remote control. The rest of the server
  starts normally.

The client connects once the HTTP listener is ready.

## Connection

- The token travels in the upgrade request as `Authorization: Bearer <token>`, never in the
  URL. Logs only ever include the hostname.
- The remote server decides whether to accept the connection. Reject the upgrade to refuse
  a client.
- The upgrade must complete within 10 seconds.
- Relaybox pings every 30 seconds and drops the connection if no pong arrives within
  10 seconds. Standard WebSocket servers answer pings automatically.
- After a disconnect it reconnects with jittered exponential backoff, starting at 1 second
  and capped at 5 minutes. The backoff resets once a connection has stayed up for
  30 seconds.

## Frames

Frames are JSON text messages. Binary frames are ignored. The maximum frame size is 1 MiB
plus 64 KiB.

Request, sent by the remote server:

```json
{ "type": "request", "requestId": "req-1", "method": "POST", "path": "/instance/create", "body": { "instanceName": "acme" } }
```

Response, sent by Relaybox:

```json
{ "type": "response", "requestId": "req-1", "status": 201, "body": {} }
```

`method`, `path`, `body`, `status`, and response bodies match the JSON API. See
[`/redoc`](../redoc) for each operation's schema. Query strings go in `path`, for example
`/instance/fetchInstances?instanceName=acme`.

| Situation | Result |
| --- | --- |
| Success | The operation's status and body |
| Frame with a `requestId` but a missing or invalid `type`, `method`, or `path` | `400` with the Evolution error envelope |
| Method/path not in the allowed list | `404` with the Evolution error envelope |
| Body or query fails validation, or a known domain error | The matching Evolution error envelope |
| Unexpected failure | `500` with a generic error envelope |
| Request received during shutdown | `503` with the Evolution error envelope |
| Invalid JSON, not an object, or no string `requestId` | Logged and dropped; no response |

Requests run concurrently, so responses can arrive in any order. Match them by `requestId`.
A response is sent only on the connection that received the request. Relaybox does not
replay requests or responses after a disconnect.

## Allowed operations

| Method | Path |
| --- | --- |
| POST | `/instance/create` |
| GET | `/instance/fetchInstances` |
| GET | `/instance/connectionState/{instanceName}` |
| GET | `/instance/connect/{instanceName}` |
| POST | `/instance/disconnect/{instanceName}` |
| POST | `/instance/rename/{instanceName}` |
| DELETE | `/instance/logout/{instanceName}` |
| DELETE | `/instance/delete/{instanceName}` |
| POST | `/webhook/set/{instanceName}` |
| GET | `/webhook/find/{instanceName}` |

These operations share validation and behavior with the HTTP routes, so a request valid on
one transport is valid on the other.

## Events

Events are not pushed over the socket. To receive instance and message events, configure a
webhook with `POST /webhook/set/{instanceName}` (over the socket or HTTP) and receive them as
HTTP deliveries, described in [`webhooks.md`](webhooks.md).

## Shutdown

When Relaybox stops (SIGTERM or SIGINT), it answers new request frames with `503` and
gives operations already running up to 3 seconds to send their responses. Then it closes the
connection.

- A `503` means the request was not applied; retry it after reconnecting.
- A request that never received a response may or may not have been applied: check state
  (for example with `fetchInstances` or `webhook/find`) after reconnecting, rather than
  blindly retrying a mutation.

## Security

- The token can create, delete, and log out instances and redirect webhooks. Treat it like
  `API_KEY`, and generate a distinct long random value for each deployment.
- Authorization is the remote server's job: it must check the bearer token on the upgrade.
- The HTTP JSON API is unaffected and still requires the `apikey` header.
