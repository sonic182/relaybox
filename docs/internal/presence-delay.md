# Plan: `delay`/`presence` typing simulation on `POST /message/sendText/:instanceName`

Mirrors the Evolution reference (`evolution-api/src/api/dto/sendMessage.dto.ts`,
`whatsapp.baileys.service.ts:2606`): when `delay` is set, the bot shows
`composing` to the recipient for `delay` ms (chunked at 20 s), then `paused`,
then delivers the message.

## Reference behaviour (source of truth)

- `delay`: integer, milliseconds. Optional.
- `presence`: one of Baileys `WAPresence` — `'unavailable' | 'available' | 'composing' | 'recording' | 'paused'`. Optional; defaults to `'composing'`.
- Flow per send: `presenceSubscribe(jid)` → `sendPresenceUpdate(presence ?? 'composing')` → wait → `sendPresenceUpdate('paused')` → `sendMessage(...)`.
- `delay > 20000` is chunked: composing → wait 20 s → paused, repeat, then the leftover, then the message.
- Applies to all send DTOs via shared `Metadata`; we only need it on `sendText` for now.
- Response shape is unchanged (still `201` + the sent message).

## Changes

### 1. `src/contracts/evolution.ts` — extend `SendTextInput`

```ts
export type SendTextInput = {
    /** A bare number or a qualified JID; a group JID sends to the group. */
    number: string;
    text: string;
    /** Show the recipient a typing/recording presence for this many ms before delivering. */
    delay?: number;
    /** Presence shown during `delay`; default `composing`. */
    presence?: 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';
};
```

API shape lives only here (AGENTS.md). Define the union inline rather than
importing `WAPresence` from baileys, keeping contracts self-contained.

### 2. `src/instances.ts` — accept options, run the typing loop

Extend the service interface, and the one implementation:

```ts
sendText(name: string, number: string, text: string, options?: SendTextOptions): Promise<InboundMessage>;
```

Add a small helper next to `sendText` (in the instance factory) that owns the
loop, so future send paths (media, etc.) reuse it:

```ts
async function typeFor(sock: WASocket, jid: string, delay: number, presence?: WAPresence) {
    const show = presence ?? 'composing';
    let remaining = delay;
    while (remaining > 20000) {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate(show, jid);
        await delayMs(20000);
        await sock.sendPresenceUpdate('paused', jid);
        remaining -= 20000;
    }
    if (remaining > 0) {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate(show, jid);
        await delayMs(remaining);
        await sock.sendPresenceUpdate('paused', jid);
    }
}
```

Call it in `sendText` after the JID check, only when `options?.delay` is set,
right before `instance.sock.sendMessage(jid, { text })`. The `20 s` chunk
matches the reference loop exactly.

### 3. `src/api/message.ts` — parse and forward

In `readSendText`:

- `delay`: optional; error `'"delay" must be a non-negative integer'` if present and not a safe integer `>= 0`.
- `presence`: optional; error if not one of the five values.

Return `{ number, text, delay?, presence? }` and pass the whole input through:
`service.sendText(instanceName, number, text, { delay, presence })`.

### 4. Tests

- `tests/integration/message-api.test.ts`: fixture gains `delay: 1500, presence: 'composing'`; assert `sendText` was called with the options object; add a 400 case for a bad `delay`, and one for an invalid `presence`.
- `tests/unit/instances.test.ts`: one test with a fake `sock` asserting the presence sequence `composing → (wait) → paused → sendMessage`, plus the >20 s chunk path (fake timers, `vi.useFakeTimers()`). This is the one check that fails if the loop breaks.
- Existing callers pass no options, so `tests/helpers.ts` fake and UI path compile unchanged (signature is additive).

## Skipped

- `presence`/`delay` for media, buttons, lists, etc. — only `sendText` exists
  in our API; add to other DTOs when they land.
- The standalone reference endpoint `/chat/sendPresence` (a presence push with
  no message) — not asked for; the reference keeps it separate.
- UI chat composer in `src/controllers/chats.ts` — no delay UI; the API is the
  consumer of this feature.