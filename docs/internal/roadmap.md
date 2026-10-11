# Messaging and Webhook API Roadmap

## Evolution API reference boundary

The local `./evolution-api` reference at version **2.4.0** (commit `e273b904`) defines the request, response, event, and webhook shapes for the subset we support. Do not depend on its implementation at runtime.

The scope is the Baileys/WhatsApp instance workflow: send messages, configure webhooks, emit webhook events, persist messages, and browse chats in the dashboard. Evolution API is a behavioral reference for those features, not a full compatibility target.

### Callback URL policy

Webhook callback URLs must be `http` or `https` in every environment; other protocols are rejected.

- **Development** (`NODE_ENV` is `development` or `test`): any `http` or `https` URL is accepted, so a local
  consumer on a LAN address or container hostname works without a tunnel.
- **Otherwise**: `https` only, except `http` on loopback (`localhost`, `127.0.0.0/8`, `::1`), and
  never a private or link-local host (RFC 1918, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`,
  `.localhost`, `.local`, `.internal`).

The check is on the hostname at configuration time, so a public name that resolves to a private
address still passes. The delivery handler re-checks the resolved address immediately before each
request (`src/delivery.ts`, `assertPublicTarget`) and refuses to follow a redirect, since a redirect
can point anywhere regardless of where the original hostname resolved.

### Unsupported routes

Anything outside the supported subset stays **unmounted**. `src/api/router.ts` mounts the JSON API
only on the prefixes listed in `API_PREFIXES`; unmatched paths under those prefixes return the
reference `404 Not Found` error envelope, and unlisted prefixes never reach the JSON API at all. No
route returns a plausible-looking but incompatible response. `public/swagger.yml` documents only
what is actually mounted, so an operation missing from it is one we do not answer.

### Webhook contract to preserve

The reference exposes these instance-scoped routes:

- `POST /webhook/set/:instanceName`
- `GET /webhook/find/:instanceName`

The configuration request body is:

```json
{
    "webhook": {
        "enabled": true,
        "url": "https://consumer.example/webhooks/whatsapp",
        "headers": { "X-Customer": "acme" },
        "byEvents": false,
        "base64": false,
        "events": ["MESSAGES_UPSERT", "CONNECTION_UPDATE"]
    }
}
```

The selected event names are uppercase underscore names (for example, `MESSAGES_UPSERT`). Delivered event values are lowercase dotted names (for example, `messages.upsert`). The reference webhook envelope contains `event`, `instance`, `data`, `destination`, `date_time`, `sender`, `server_url`, and `apikey`, plus event-specific extra fields. Contract fixtures must capture the exact payload for every supported event before implementation.

## Architecture rules

- Keep HTML controllers and JSON API controllers separate, but let both call the same application services.
- Keep Baileys adapters, persistence, and outbound HTTP clients out of Express controllers.
- Convert raw Baileys updates into typed internal events, then convert those into Evolution-compatible payloads at the delivery boundary. Never expose raw Baileys objects as a public contract.
- Persist a webhook delivery before attempting outbound HTTP. A worker performs delivery and retries; socket callbacks must never wait on remote webhook requests.
- Scheduling and delivery are separate seams: `DeliveryQueue` (`src/queue.ts`) owns enqueue/consume and retry timing; `DeliveryHandler` (`src/delivery.ts`) only performs one HTTP attempt and reports an outcome. `createDatabaseQueue` is the current adapter — the `WebhookDelivery` table is the queue, polled on an interval, no broker required. A Redis/BullMQ-backed `DeliveryQueue` can replace it later without touching the handler or the outbox. Known ceiling: no row claim, so it is single-process only; a second consumer would redeliver the same due rows.
- One credential, `API_KEY`, covers both surfaces: the dashboard login stores an HMAC derived from it in the httpOnly `relaybox_session` cookie and the JSON API reads it from the `apikey` header. The API keeps its own middleware and documented error format. A leaked key therefore grants both dashboard and API access; split the credentials again if that stops being acceptable.
- Protect outbound webhook delivery against SSRF, credential leakage in logs, unbounded retries, and duplicate delivery. Webhook delivery is at-least-once; consumers must be able to deduplicate with a delivery id.

## Phases

### Phase 0 — Freeze the supported API contract

- [x] Record the exact Evolution API reference revision and supported compatibility subset in this file and in API documentation.
- [x] Document the API in `public/swagger.yml`, which `/redoc` and `/swagger.json` serve. It covers what is mounted and nothing else; the planned-operation inventory that used to live in `docs/swagger.yml` was dropped, since two specs maintained by hand drifted apart instead of one staying right.
- [x] Create `src/contracts/evolution.ts` for event constants, request/response types, and envelope builders; do not import types from `./evolution-api`.
- [x] Add JSON fixtures for successful and invalid webhook configuration requests, configuration reads, and webhook envelopes (`tests/fixtures/evolution/`).
- [x] Add contract tests that compare this application's JSON responses and webhook bodies to the fixtures. Envelope and error bodies are covered now; route responses are asserted as each route lands.
- [x] Define the initial supported events: `QRCODE_UPDATED`, `CONNECTION_UPDATE`, `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `MESSAGES_DELETE`, and `SEND_MESSAGE`.
- [x] Document every intentionally unsupported Evolution route/event as `501 Not Implemented` or leave it unmounted; do not silently return incompatible data. Decision: leave unmounted, see *Unsupported routes* above.

### Phase 1 — Durable API and persistence foundation

This phase creates the minimum shared infrastructure needed by the UI, API, ingestion, and delivery worker. It does not add a broad JSON API without a useful end-to-end flow.

- [x] Keep `createApp()` injectable and side-effect free for HTTP tests.
- [x] Add `apikey` authentication compatible with the reference header name, using constant-time comparison and stable JSON errors (`src/api/auth.ts`, `src/auth.ts`). `API_KEY` is also the dashboard login credential.
- [x] Add a JSON API router separate from the HTML/htmx routes and a shared API error mapper (`src/api/router.ts`, `src/api/errors.ts`).
- [x] Add ZenStack models and migrations for `InstanceRecord`, `WebhookConfig`, `Chat`, `Message`, and `WebhookDelivery` (the durable outbox).
- [x] Keep Baileys credentials and signal keys in the session directory; never store them in the database.
- [ ] Define repository ports for instances, webhook configuration, messages, and deliveries; bind ZenStack implementations at the composition root.
    - Deferred on purpose: the ZenStack client is injected at the composition root (`src/index.ts`) and services take it directly. Tests use a migrated in-memory database (`createTestDb()`), which catches constraint bugs a hand-written fake cannot. Extract ports when a second implementation or an untestable dependency appears.
- [x] Persist a stable instance id, name, and lifecycle metadata so webhook settings and message history survive restarts.
- [x] Add migration and repository tests, including uniqueness/idempotency constraints for message keys and delivery ids (`tests/unit/db.test.ts`).

### Phase 2 — First end-to-end slice: configure → deliver → ingest

Get a configured URL actually receiving webhooks, then widen the event source to inbound messages.
Configuration alone is not a feature, and webhooks must not run inline in Baileys callbacks.

#### 2.1 Configure webhooks through API and UI

- [x] Implement `POST /webhook/set/:instanceName` and `GET /webhook/find/:instanceName` with the reference request and response fixtures (`src/api/webhook.ts`).
- [x] Add a dashboard webhook settings form that calls the same `WebhookService` as the JSON API (`/instances/:name/webhook`).
- [x] Validate instance existence, event selection, custom headers, and callback URLs; define an explicit local-development policy for HTTP callback URLs. See *Callback URL policy* below.
- [x] Keep configured secrets out of rendered pages, logs, and read responses where the reference permits redaction. Header values are returned by `GET /webhook/find` because the reference returns the stored row, but they are never rendered in the dashboard: the form shows header names with masked values, and an empty headers field keeps the stored values instead of round-tripping them through the browser.

#### 2.2 Deliver selected events reliably

Delivery comes before message ingestion on purpose. Connection and QR events need no
`Message` row, and `InstanceService` already emits them, so the hard parts — retries, SSRF at
delivery time, deduplication, restart recovery — get proven on trivial payloads. `MESSAGES_UPSERT`
then joins an outbox that already works.

- [x] `InstanceService` exposes isolated state and lifecycle subscriptions (`created`, `updated`, and `deleted`); the outbox (`src/outbox.ts`) is now its first consumer.
- [x] Add a typed internal event union with correlation id and occurrence timestamp (`src/events.ts`, `DomainEvent`).
- [x] Map Baileys QR and connection updates to `QRCODE_UPDATED` and `CONNECTION_UPDATE` (`src/instances.ts` tags each update with `change: 'qr' | 'connection'`; `src/events.ts` maps it).
- [x] Create a queued delivery for each selected event, beginning with `CONNECTION_UPDATE` and `QRCODE_UPDATED`; `MESSAGES_UPSERT` joins in 2.3 (`src/outbox.ts`).
- [x] Build the Evolution-compatible envelope and `byEvents` kebab-case URL suffix (for example, `/messages-upsert`) (`src/contracts/evolution.ts`, applied in `src/outbox.ts`).
- [x] Run a delivery worker with timeout, bounded exponential backoff, jitter, configurable non-retryable HTTP statuses, and restart recovery (`src/delivery.ts`, `src/queue.ts`). Restart recovery needs no dedicated code: an interrupted job is still `pending` with `nextAttemptAt` in the past.
- [x] Re-check the resolved address at delivery time and refuse redirects to private or link-local hosts (`src/delivery.ts`, `assertPublicTarget`, `redirect: 'manual'`).
- [x] Send configured headers and safe observability headers (`x-delivery-id`, `x-event-type`) without changing the JSON body (`src/delivery.ts`).
- [x] Add delivery history to the dashboard without exposing secrets (`listDeliveries` in
  `src/webhooks.ts`, rendered on `/instances/:name/webhook`). The columns are selected
  explicitly: the payload carries message content and the envelope `apikey`, and a callback
  URL can carry a token in its path, so neither is read or rendered.
    - No JSON API route. The reference has no delivery history at all — it fires webhooks
      in process, with no outbox and no table — so there is no contract to reproduce, and
      inventing a path under an Evolution prefix would break the *Unsupported routes* rule.
      Add one under its own prefix if a client ever needs it.
- [x] Test successful delivery, network failure, 4xx, 5xx, disabled hooks, retry with backoff, exhausted retries, and duplicate delivery behavior (`tests/unit/delivery.test.ts`, `tests/unit/queue.test.ts`, `tests/unit/outbox.test.ts`).

#### 2.3 Watch instances and save messages

- [x] Map Baileys `messages.upsert` to a normalized inbound-message event; store key fields, direction, timestamp, message type, remote JID, and raw payload JSON (`toInboundMessage` in `src/instances.ts` emits an `InstanceEvent` of type `messages`; Baileys objects stop there).
- [x] Upsert a lightweight `Chat` projection per instance and remote JID, including the latest-message timestamp and preview needed for a chat list (`src/messages.ts`, `projectChat`). Backfill cannot overwrite a newer preview: the update is conditional on `lastMessageAt`.
- [x] Make message persistence idempotent using the instance and WhatsApp message key, then publish only after the database write succeeds. The `@@unique([instanceId, remoteJid, fromMe, keyId])` constraint rejects the duplicate and `store()` returns false, so nothing is published.
- [x] Feed `MESSAGES_UPSERT` into the 2.2 outbox once persistence is idempotent (`src/messages.ts` calls `outbox.enqueue(toMessageEvent(...))`; `toDomainEvents` deliberately returns `[]` for message events so the outbox cannot publish one ahead of its row).
- [x] Add fixture-driven tests for normal messages, batches, duplicates, malformed updates, and restart recovery (`tests/unit/messages.test.ts`, driven by `tests/fixtures/evolution/messages-upsert.baileys.json` and the `envelope.messages-upsert.json` `data` shape).

Not covered here: media download, `pollUpdateMessage` vote decryption, and group-ignore settings.
`MESSAGES_UPDATE` and `MESSAGES_DELETE` land in phase 4 with their fixtures.

Learned from running this against a live pairing, all now covered by tests:

- **LID addressing.** WhatsApp addresses some chats by LID, an opaque id whose digits are not
  a phone number. `toInboundMessage` prefers the phone-number JID from `remoteJidAlt`, keeps
  the LID beside it, and reports `addressingMode: 'pn'`, as the reference does.
- **Protocol events are not messages.** A revoke, an edit, or a disappearing-timer change is
  dropped rather than delivered, matching the reference. Delivering one puts an empty message
  in a consumer's inbox.
- **Baileys hands back protobuf instances**, not plain objects, and the ORM rejects them.
  Everything is round-tripped through JSON at the Baileys boundary.
- **`contextInfo` is stored beside `message`**, in its own column as the reference does. It is
  metadata — mentions, quotes, and the click-to-WhatsApp ad a lead arrived from — and the
  extended-text collapse used to delete it along with its node.
- Ingestion failures other than a duplicate key are logged as errors. Treating every write
  failure as a duplicate lost messages silently.

### Phase 3 — Core outbound messaging API

Sending reuses the publisher and outbox from phase 2, so it lands before the read UI.

- [x] Implement the smallest useful send-text endpoint and response fixture
  (`POST /message/sendText/:instanceName`, `src/api/message.ts`). The shape follows what the
  consumer actually calls: it reads `body.key.id` and treats any status other than `201` as a
  failed send, so the status code and that key are the contract. The response is built by
  `toInboundMessage`, so it, the stored row, and the webhook body share a shape by
  construction rather than by discipline.
- [x] Emit `SEND_MESSAGE` through the same event publisher and outbox. `InstanceService`
  emits a `sent` event and `toDomainEvents` maps it, so the outbox needed no new wiring. The
  event name is part of the dedupe key; without that the `messages.upsert` echo of the same
  send would collide with its `SEND_MESSAGE` and one would be dropped.
    - Outbound messages are **not** persisted in the send path: Baileys echoes the send back
      through `messages.upsert` with `fromMe: true`, and the 2.3 ingestion stores it there.
    - `SEND_MESSAGE_UPDATE` stays open; it belongs with `MESSAGES_UPDATE` in phase 4.
- [x] Add idempotency keys for send operations before accepting production traffic
  (`src/sends.ts`, optional `Idempotency-Key` header). No contract to copy: the reference has
  none, so a retried `sendText` sends twice there. This is our own design.
    - The key is claimed in `SendRequest` *before* the message leaves, so two concurrent
      retries race against a unique constraint here rather than at WhatsApp. The response is
      stored on the claim and replayed identically.
    - A retry arriving while the first is still in flight gets `409`; a send that fails
      releases its key, so a transient socket error stays retryable.
    - Omitting the header keeps the old behaviour: a caller that did not ask for the
      guarantee does not get it imposed.
Additional outbound formats are deferred to phase 4.1, where each remains opt-in and fixture-backed.

**Not yet verified against a live pairing.** No message has been sent through this endpoint to
a real WhatsApp account. Every layer of 2.3 that was only test-covered turned out to hide a
bug — LID addressing, protobuf instances rejected on write, protocol events delivered as
messages — so treat this as unproven until a real send succeeds.

### Phase 4 — Chat browser and read API surface

The dashboard becomes a useful operational UI after messages are persisted. It reads database
projections; the one exception is sending a reply, which goes through `InstanceService`.

- [ ] Add read-only instance endpoints: list and QR/connect state, with fixture-backed JSON responses.
    - Connection state is done: `GET /instance/connectionState/:instanceName` (`src/api/instance.ts`)
      reuses the `CONNECTION_STATES` map the webhook payloads use, so the endpoint and
      `CONNECTION_UPDATE` cannot disagree. Our `qr` step reports as `connecting`.
- [x] Add chat-list and cursor-paginated message-history queries scoped to an instance and
  remote JID (`src/chats.ts`). The cursor carries the row id beside the WhatsApp timestamp:
  several messages routinely share a second, and a timestamp-only cursor skips or repeats
  them across page boundaries.
- [x] Add an instance chat browser to the dashboard (`/instances/:name/chats`), with the
  latest-message preview, the selected-chat timeline, direction, timestamp, message type,
  empty and error states, and cursor-based older-message loading. It also replies, through
  the same `sendText` the JSON API uses.
    - No loading state: every response is server-rendered in one round trip, so there is no
      moment to show one. Add it if a query ever gets slow enough to need it.
- [x] Render normalized message content safely (`ChatMessage` lifts out plain text only;
  anything else is described by its type, so no media key or raw payload reaches the page).
  Escaping is asserted rather than assumed.
- [x] Add UI integration tests for instance isolation, ordering, pagination, empty chats, and
  escaped message content (`tests/integration/chats-ui.test.ts`).
- [x] Add `MESSAGES_UPDATE` for numeric delivery receipts and `MESSAGES_DELETE` for revokes and
  `messages.delete` sync events. Updates are serialized per instance after upserts; revokes mark the
  stored row `DELETED` and never expose its content in the dashboard.
    - `MESSAGES_EDITED` and `SEND_MESSAGE_UPDATE` stay unsupported. They need their own reference
      fixtures and an outbound edit endpoint, rather than overloading receipt updates.
- [x] Preserve raw source payloads while exposing a stable normalized public contract:
  `Message.content` keeps what Baileys sent and `Message.contextInfo` the metadata beside it,
  while `ChatMessage` and the webhook envelope expose only normalized fields.

Group names come from `groups.upsert`/`groups.update` rather than from messages, because
`pushName` is the sender's name. Contact names for one-to-one chats still come from
`pushName` alone; `contacts.upsert` is logged at debug and not ingested.

### Phase 4.1 — Remaining support and operations

Keep this phase demand-driven: no format, endpoint, or operational surface lands without a caller.

- [ ] Add additional outbound message formats only when required, each with contract fixtures and explicit support status.
    - `sendText`, `sendMedia` (image/video/document/audio), and `sendWhatsAppAudio` (push-to-talk,
      ffmpeg-transcoded to ogg/opus) are done. Sticker, location, contact, reaction, poll,
      buttons, list, carousel, ptv, status, and template stay `planned` until a caller needs one.
    - The reference's `API_AUDIO_CONVERTER` offload is deliberately skipped: local ffmpeg covers
      it, and an external transcoder only matters where the process cannot spawn one.
    - `toRecipientJid` still does no country-specific fixups; the reference rewrites Brazilian
      numbers to add or drop the ninth digit (`ponytail:` comment in `src/instances.ts`).
    - Diffed against a local clone of the reference at tag `2.3.7` (`.references/evolution-api`,
      gitignored). `quoted`, `mentioned`, `mentionsEveryOne` and `linkPreview` are honoured
      across all three sends, and every response carries `instanceId`. Of the reference's
      `Metadata` fields only `webhookUrl` (a per-send override of the callback) is still ignored.
    - `sendMedia` infers a missing `mimetype` from the `fileName` extension, the URL path
      extension, the fetched `content-type` (only when plausible for the media kind), then the payload's leading bytes (`src/mimeTypes.ts`,
      a fixed table), and derives a missing document `fileName` from the URL path. It answers 400
      only when none of these identify the type.
- [x] Add `MESSAGES_EDITED` and `SEND_MESSAGE_UPDATE` with their own reference fixtures and an
  outbound edit endpoint; do not overload receipt updates. `POST /chat/updateMessage/:instanceName`
  accepts the reference `{ number, text, key }` body, returns the Baileys edit response, and sends
  the raw protocol payload through the durable outbox.
- [ ] Add read-only instance list and QR/connect endpoints with fixture-backed JSON responses.
  Connection state is already available at `GET /instance/connectionState/:instanceName`.
- [x] Complete structured logging and redaction for message content, webhook headers, and response
  `set-cookie` (`src/logger.ts`). Baileys logs contain metadata only; Pino removes headers and
  message fields. Metrics and health/readiness checks are out of scope.
- [x] Prune completed `SendRequest` rows so idempotency storage is bounded. Completed responses
  expire after seven days; startup and a daily unref'd timer run the cleanup (`src/index.ts`).
- [x] Ingest contact names from `contacts.upsert` rather than using a contact's `pushName`.
  Contact events name existing direct-chat projections only, so the chat browser never becomes an
  address book; add persisted contacts if names must survive an event that arrives before a chat.

### Out of scope

OpenAPI/support-matrix generation, metrics, health/readiness endpoints, retention and encryption
policy work, and multi-process worker deployment are not planned work.

## Immediate next task

Phases 0, 1, and 2 are done; the repository ports in phase 1 stay deliberately deferred.
`CONNECTION_UPDATE`, `QRCODE_UPDATED`, and `MESSAGES_UPSERT` all reach a configured consumer:

1. Configure the events for an instance through the dashboard or `POST /webhook/set/:instanceName`.
2. Reconnect the instance, or send it a WhatsApp message.
3. An inbound message is persisted first (`src/messages.ts`), then a delivery is queued
   (`src/outbox.ts` via `DeliveryQueue.enqueue`). Connection and QR events queue directly.
4. The delivery worker delivers it to the configured URL, retrying on failure (`src/delivery.ts`, `src/queue.ts`).

The result is visible without a database client: `/instances/:name/webhook` lists recent
delivery attempts under the settings form.

Sending works too, and both directions have been exercised against a live WhatsApp pairing
rather than only against tests: a real send answered `201`, replayed identically for a
repeated `Idempotency-Key` without sending twice, was persisted through the `messages.upsert`
echo, and produced `SEND_MESSAGE` and `MESSAGES_UPSERT` deliveries that the consumer accepted.

The dashboard reads and answers those conversations at `/instances/:name/chats`.

**Next: the remaining phase 4.1 work.**

Still open, in the order they are worth doing:

1. `sendMedia` (image/video/document) landed; further outbound formats only when a caller
   needs one.
2. Read-only instance list and QR/connect endpoints. Connection state is done.

The configured-consumer path is covered end to end by
`tests/integration/webhook-delivery.test.ts`: it persists an inbound message, queues its
webhook, drains the delivery queue, and verifies the envelope received by a local HTTP server.

Also open: `tsc --noEmit` does not cover `tests/`, so a test-only type error reaches neither
the typecheck nor CI. One has already slipped through this way.
