# History sync

When a device is paired, WhatsApp sends part of its chat history. Relaybox can store those
chats, contact names and messages, so `list_chats` and `list_messages` also show conversations
from before the pairing. It is controlled per instance by the `syncFullHistory` setting, which is
**off by default**. The API reference is available at [`/redoc`](../redoc).

## What it does

- `syncFullHistory: true` imports the history WhatsApp sends while pairing.
- `syncFullHistory: false` ignores it.
- Imported messages are not published as webhooks. Media is not bulk-downloaded during import.
  MCP `get_media` downloads an uncached file on demand through the connected WhatsApp instance,
  caches it, and returns a signed URL. Downloads are bounded by the existing media size limit
  and a 30-second network timeout. Older files may be unavailable even after a reupload request;
  those requests still return 404. No new history setting is needed.
- WhatsApp only sends this history while pairing, and the phone decides how much. Enabling the
  setting on an instance that is already paired imports nothing until it is logged out
  (`DELETE /instance/logout/{instanceName}` or the `logout_instance` MCP tool) and a new QR is
  scanned.
- History messages and contact names are imported in batches, allowing live traffic between batches.
- Setting reads are retried up to three times with short backoff. If the setting still cannot
  be read (for example a database error), that history is skipped and logged. WhatsApp does not resend it, so log out and pair again to
  retry.
- Turn it on before scanning the QR. The setting is read when the history arrives, so changing
  it while the QR is on screen also works.

## Setting it

In the dashboard, choose **Create instance** and check **Import history when pairing** before
creating and scanning the QR. For an existing instance, open **Edit instance settings**, enable
history and save. Return to Instances, choose **Unpair to re-scan QR**, then **Re-scan QR** and
pair again. Saving settings alone does not import history from an already paired device.

When creating the instance:

```bash
curl -X POST 'https://your-server.example/instance/create' \
  -H 'apikey: YOUR_API_KEY' \
  -H 'content-type: application/json' \
  --data '{"instanceName": "acme", "qrcode": true, "syncFullHistory": true}'
```

Or afterwards, with the settings endpoints:

```bash
curl -X POST 'https://your-server.example/settings/set/acme' \
  -H 'apikey: YOUR_API_KEY' \
  -H 'content-type: application/json' \
  --data '{"syncFullHistory": true}'

curl 'https://your-server.example/settings/find/acme' -H 'apikey: YOUR_API_KEY'
```

The MCP server exposes the same through `create_instance`, `set_settings` and `find_settings`.

## LID / phone identity reconciliation

WhatsApp can address the same contact by a phone JID or an opaque `@lid` identifier. Imports
and live messages resolve reciprocal mappings from the stored Baileys Signal keys, retaining
the LID as the alternate address. Late `lid-mapping.update` events reconcile earlier chats.
Unknown LIDs are never treated as phone numbers. No additional migration is needed.

For existing data, preview a one-time repair (read-only by default):

```sh
pnpm run chats:repair-identities --instance acme --dry-run
# In the rebuilt Docker image:
docker compose exec relaybox node dist/src/repairChatAliases.js --instance acme --dry-run
```

Review the report and take a database backup before applying. Stop **all writers** for the
instance (production/dev app and other ingestion processes). With Docker Compose, keep
PostgreSQL running and use a separate maintenance container, bypassing the app entrypoint:

```sh
docker compose stop relaybox
# Stop relaybox-dev too if running.
docker compose run --rm --no-deps --entrypoint node relaybox \
  dist/src/repairChatAliases.js --instance acme --apply --offline
docker compose up -d relaybox
```

`--offline` confirms that writers have been stopped; it does not stop them for you. Each
identity is reconciled in a transaction and the command is repeatable. Phone contact names
are preferred, the newest chat preview is retained, and message/media rows move to the
phone identity. Identical duplicate messages are collapsed without deleting media files;
media ownership and advanced receipts are preserved. Conflicting content, metadata,
edit/delete states or media block the whole identity merge, and unresolved mappings are
reported without changes. Repair does not publish webhooks or fetch WhatsApp history.

## Differences from Evolution API

Relaybox follows the reference's `syncFullHistory` setting and its `/settings/set` and
`/settings/find` endpoints, but the meaning differs:

| | Evolution API 2.3.7 | Relaybox |
| --- | --- | --- |
| `syncFullHistory: false` | Still receives the recent history | Ignores the history |
| `syncFullHistory: true` | Asks WhatsApp for the full history | Imports the history WhatsApp sends |
| Whether history is stored | `DATABASE_SAVE_DATA_HISTORIC` environment variable | The per-instance setting; no environment variable |
| History webhooks | `CHATS_SET` and `MESSAGES_SET` are always sent | None are sent |
| Other settings (`rejectCall`, `groupsIgnore`, `alwaysOnline`, `readMessages`, `readStatus`, `msgCall`, `wavoipToken`) | Accepted; the reference requires most of them | Not supported; any other field returns 400 |
| `POST /settings/set` response | `{ settings: { instanceName, settings } }` | Same |
| `GET /settings/find` response | The settings object, or `null` | The settings object; defaults when none were set |

`true` does not change how Relaybox connects to WhatsApp, so it does not request the full
(Desktop-client) history the reference asks for. What arrives is what WhatsApp sends to a regular
linked device, usually the recent history. A client that sends the reference's full settings body
to `/settings/set` receives a 400 naming the unsupported field.
