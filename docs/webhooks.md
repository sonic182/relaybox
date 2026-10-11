# Webhooks

Relaybox sends outbound JSON webhooks for supported WhatsApp and instance events. This
page documents receiving those requests; the API reference for configuring them is available
at [`/redoc`](../redoc).

## Setup

1. Open an instance's webhook settings in the dashboard at
   `/instances/{instanceName}/webhook`.
2. Set the callback URL, optional custom headers, event selection, and (if needed) signing.
3. Save the configuration.

The same configuration can be applied with the JSON API:

```bash
curl -X POST 'https://your-server.example/webhook/set/acme' \
  -H 'apikey: YOUR_API_KEY' \
  -H 'content-type: application/json' \
  --data '{
    "webhook": {
      "enabled": true,
      "url": "https://consumer.example/webhooks/whatsapp",
      "headers": {"X-Customer": "acme"},
      "signatureSecret": "example-signing-secret-16",
      "signatureEnabled": true,
      "byEvents": false,
      "base64": false,
      "events": ["MESSAGES_UPSERT", "CONNECTION_UPDATE"]
    }
  }'
```

## Authentication

Calls to this server's JSON API require the `apikey` request header. Outbound webhook
requests use the custom headers configured for the webhook. The `apikey` field in the
outbound envelope is currently an empty compatibility field: it is **not** a secret and must
not be used for authentication.

## Events

Only these events can be selected. The configured names and delivered names are:

| Configured event | Delivered `event` | Example payload |
| --- | --- | --- |
| `QRCODE_UPDATED` | `qrcode.updated` | [`envelope.qrcode-updated.json`](../tests/fixtures/evolution/envelope.qrcode-updated.json) |
| `CONNECTION_UPDATE` | `connection.update` | [`envelope.connection-update.json`](../tests/fixtures/evolution/envelope.connection-update.json) |
| `MESSAGES_UPSERT` | `messages.upsert` | [`envelope.messages-upsert.json`](../tests/fixtures/evolution/envelope.messages-upsert.json) |
| `MESSAGES_EDITED` | `messages.edited` | [`envelope.messages-edited.json`](../tests/fixtures/evolution/envelope.messages-edited.json) |
| `MESSAGES_UPDATE` | `messages.update` | [`envelope.messages-update.json`](../tests/fixtures/evolution/envelope.messages-update.json) |
| `MESSAGES_DELETE` | `messages.delete` | [`envelope.messages-delete.json`](../tests/fixtures/evolution/envelope.messages-delete.json) |
| `SEND_MESSAGE` | `send.message` | [`envelope.send-message.json`](../tests/fixtures/evolution/envelope.send-message.json) |
| `SEND_MESSAGE_UPDATE` | `send.message.update` | [`envelope.send-message-update.json`](../tests/fixtures/evolution/envelope.send-message-update.json) |
| `STATUS_UPDATE` | `status.update` | Project extension for WhatsApp stories (`status@broadcast`); opt in explicitly. |

## Filtering and destination

- An enabled webhook with omitted or empty `events` subscribes to all reference-compatible events.
  `STATUS_UPDATE` is a project extension and stays opt-in, so add it explicitly to receive stories.
- Disabling a webhook clears its event selection.
- With `byEvents: false`, requests go to the configured `url`.
- With `byEvents: true`, the server appends the hyphenated event path. For example,
  `MESSAGES_UPSERT` is delivered to `/messages-upsert` below the configured URL.

## Payload

Every delivery is a JSON `WebhookEnvelope`. This is a complete example:

```json
{
  "event": "messages.upsert",
  "instance": "acme",
  "data": {
    "key": {
      "remoteJid": "5511888888888@s.whatsapp.net",
      "fromMe": false,
      "id": "3EB0C767D26B8A3F1A2B0000000000AB"
    },
    "pushName": "Jane",
    "message": { "conversation": "hello there" },
    "messageType": "conversation",
    "messageTimestamp": 1756555200,
    "instanceId": "clw0instance00000000000001",
    "source": "android",
    "status": "DELIVERY_ACK"
  },
  "destination": "https://consumer.example/webhooks/whatsapp",
  "date_time": "2026-08-30T12:00:00.000Z",
  "sender": "5511999999999@s.whatsapp.net",
  "server_url": "http://localhost:3000",
  "apikey": ""
}
```

- `event` is the lowercase, dotted event name delivered to the consumer.
- `instance` identifies the Relaybox instance.
- `data` is the event-specific payload.
- `destination` is the configured callback URL, before any `byEvents` suffix.
- `date_time` is the event time in ISO 8601 format.
- `sender` is the paired WhatsApp ID when available.
- `server_url` identifies the Relaybox server.
- `apikey` is currently always empty for compatibility and contains no credential.

## Delivery behavior

Requests are `POST` requests with a JSON body and `content-type: application/json`. The
server also sends `x-delivery-id` and `x-event-type` headers.

- Any `2xx` response marks the delivery successful.
- Redirects are refused; the server does not follow them.
- `408`, `429`, and `5xx` responses are retried.
- Other `4xx` responses are not retried.
- Delivery is at-least-once. Consumers must deduplicate using the delivery/message event
  key rather than assuming each request is unique.

## Signed deliveries

When `signatureEnabled` is true, every delivery includes `x-webhook-signature` as
`sha256=<hex HMAC>` of the exact raw request body, using the configured secret. Secrets must
be at least 16 characters. Generate and copy a secret from the dashboard instead of choosing
one manually; the generated value is visible only for the current page lifetime.

Verify the raw bytes before parsing JSON, and compare signatures with a timing-safe operation:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
const received = request.headers['x-webhook-signature'] ?? '';
const valid =
  received.length === expected.length &&
  timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'));
```

Reject the request unless `valid` is true. Do not reserialize parsed JSON before calculating
the HMAC: that can change the bytes and make a valid signature fail.

## Security

Use HTTPS for production callback URLs. Validate the callback policy before saving it, verify
a shared custom header on every incoming webhook, and never expose the dashboard/API key to
a webhook consumer. The configured custom header values are sent with each delivery.

## Known limitation

`webhook.base64` is stored as compatibility configuration, but it is not currently used by
the delivery outbox. Setting it does not enable base64 media payloads yet.
