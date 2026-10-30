import { SUPPORTED_EVENTS, WEBHOOK_EVENTS } from './contracts/evolution';
import type { Instance, InstanceStatus } from './instances';
import type { SettingsResponse } from './contracts/evolution';
import type { ChatMessage, ChatSummary, MessagePage } from './chats';
import type { DeliveryHistoryEntry } from './webhooks';
import { Badge, Dropdown, DropdownItem, DropdownLink, Layout, type Tone } from './components';

export function loginPage(): string {
    return String(
        <Layout title="Login — relaybox">
            <div class="max-w-sm mx-auto mt-24 bg-white p-8 rounded-lg shadow">
                <h1 class="text-xl font-semibold mb-4">Enter API key</h1>
                <form id="login-form" hx-post="/login" hx-target="#error" hx-swap="innerHTML">
                    <input
                        id="token"
                        name="token"
                        type="password"
                        placeholder="API key"
                        class="w-full border rounded px-3 py-2 mb-3"
                        required
                    />
                    <button type="submit" class="w-full bg-slate-800 text-white rounded px-3 py-2">
                        Log in
                    </button>
                </form>
                <div id="error" class="text-red-600 text-sm mt-3"></div>
            </div>
        </Layout>,
    );
}

export function loginError(): string {
    return 'Invalid token';
}

export function loginThrottled(): string {
    return 'Too many attempts; try again in a minute';
}

const STATUS_TONES: Record<InstanceStatus, Tone> = {
    connecting: 'amber',
    qr: 'sky',
    open: 'emerald',
    close: 'rose',
};

const STATUS_LABELS: Record<InstanceStatus, string> = {
    connecting: 'Connecting',
    qr: 'Scan the QR',
    open: 'Connected',
    close: 'Disconnected',
};

function InstanceCard({ instance }: { instance: Instance }) {
    return (
        <div class="border rounded p-4 mb-3">
            <div class="flex justify-between items-center">
                <div>
                    <span class="font-medium">{instance.name}</span>
                    <span class="ml-2">
                        <Badge tone={STATUS_TONES[instance.status]}>
                            {instance.status === 'close' && instance.loggedOut
                                ? 'Logged out'
                                : STATUS_LABELS[instance.status]}
                        </Badge>
                    </span>
                    {instance.user ? (
                        <div class="text-sm text-slate-500 mt-1">{instance.user}</div>
                    ) : null}
                </div>
                <Dropdown>
                    {instance.status === 'close' ? (
                        <DropdownItem
                            post={`/instances/${instance.name}/connect`}
                            target="#instances"
                            tone="emerald"
                        >
                            {instance.loggedOut ? 'Re-scan QR' : 'Reconnect'}
                        </DropdownItem>
                    ) : (
                        <DropdownItem
                            post={`/instances/${instance.name}/disconnect`}
                            target="#instances"
                        >
                            Disconnect
                        </DropdownItem>
                    )}
                    <DropdownItem
                        post={`/instances/${instance.name}/rename`}
                        target="#instances"
                        prompt={`New name for ${instance.name}`}
                    >
                        Rename
                    </DropdownItem>
                    <DropdownLink href={`/instances/${instance.name}/settings`}>Edit instance settings</DropdownLink>
                    <DropdownItem
                        post={`/instances/${instance.name}/unpair`}
                        target="#instances"
                        confirm={`Unpair ${instance.name}? Enable history in instance settings first, then re-scan the QR.`}
                        tone="amber"
                    >
                        Unpair to re-scan QR
                    </DropdownItem>
                    <DropdownLink href={`/instances/${instance.name}/chats`}>Chats</DropdownLink>
                    <DropdownLink href={`/instances/${instance.name}/webhook`}>
                        Webhook settings
                    </DropdownLink>
                    <DropdownItem
                        post={`/instances/${instance.name}/delete`}
                        target="#instances"
                        confirm={`Delete ${instance.name}? This unpairs the device.`}
                        tone="rose"
                    >
                        Delete
                    </DropdownItem>
                </Dropdown>
            </div>
            {instance.qr ? (
                <div data-qr={instance.qr} class="mt-4 flex justify-center"></div>
            ) : null}
        </div>
    );
}

function InstanceList({ instances }: { instances: Instance[] }) {
    if (!instances.length) return <div class="text-slate-500">No instances yet.</div>;
    return (
        <>
            {instances.map((instance) => (
                <InstanceCard instance={instance} />
            ))}
        </>
    );
}

/** htmx fragment: the instance list, polled from the dashboard. */
export function instanceList(instances: Instance[]): string {
    return String(<InstanceList instances={instances} />);
}

function HistoryOption({ enabled }: { enabled: boolean }) {
    return (
        <div class="my-4">
            <label class="flex items-center gap-2 font-medium">
                <input type="checkbox" name="syncFullHistory" checked={enabled} aria-describedby="history-help" />
                Import history when pairing
            </label>
            <p id="history-help" class="text-sm text-slate-500 mt-2">
                Enable before scanning the QR. Already paired? Unpair and scan a new QR to import history.
                WhatsApp decides how much history to send. Media is not downloaded during import; MCP get_media can fetch it on demand.
            </p>
        </div>
    );
}

function CreateInstanceForm({ name = '', errors = [], enabled = false }: { name?: string; errors?: string[]; enabled?: boolean }) {
    return (
        <form id="create-instance-form" hx-post="/instances" hx-target="#create-instance-form" hx-swap="outerHTML" class="grid gap-5"
            {...{ 'hx-on::after-request': "if (event.detail.successful) { document.getElementById('create-instance-dialog').close(); this.querySelector('[name=name]').defaultValue = ''; this.querySelector('[name=syncFullHistory]').defaultChecked = false; this.querySelectorAll('[role=alert]').forEach(el => el.remove()); this.reset(); }" }}>
            <h2 id="create-instance-title" class="text-xl font-semibold text-slate-900">Create instance</h2>
            {errors.map((error) => <p role="alert" class="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>)}
            <div class="grid gap-2">
                <label for="instance-name" class="text-sm font-medium text-slate-700">Instance name</label>
                <input id="instance-name" name="name" value={name} placeholder="e.g. sales" pattern="[a-zA-Z0-9_\-]{1,32}"
                    required maxlength={32} autofocus class="w-full border rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-sky-500" />
            </div>
            <HistoryOption enabled={enabled} />
            <div class="grid grid-cols-2 gap-3 sm:ml-auto sm:w-64">
                <button type="button" onclick="document.getElementById('create-instance-dialog').close()" class="border rounded px-3 py-2">Cancel</button>
                <button type="submit" class="bg-slate-800 text-white rounded px-3 py-2">Create</button>
            </div>
        </form>
    );
}

export function createInstanceForm(name: string, errors: string[], enabled = false): string {
    return String(<CreateInstanceForm name={name} errors={errors} enabled={enabled} />);
}

export function instanceSettingsPage(name: string, settings: SettingsResponse, notice: { saved?: boolean; error?: string } = {}): string {
    return String(
        <Layout title={`Instance settings — ${name}`}>
            <main class="max-w-3xl mx-auto mt-12 p-6 bg-white rounded-lg shadow">
                <a href="/dashboard" class="text-sm text-sky-700">← Instances</a>
                <h1 class="text-2xl font-semibold mt-4 mb-6">Edit instance settings — {name}</h1>
                {notice.saved ? <p role="status" class="text-emerald-700">Instance settings saved.</p> : null}
                {notice.error ? <p role="alert" class="text-rose-600">{notice.error}</p> : null}
                <form method="post" action={`/instances/${name}/settings`}>
                    <HistoryOption enabled={settings.syncFullHistory} />
                    <p class="text-sm text-slate-500 mb-4">To import history after saving, return to Instances and choose “Unpair to re-scan QR”, then “Re-scan QR”.</p>
                    <div class="my-4">
                        <label class="flex items-center gap-2 font-medium">
                            <input type="checkbox" name="alwaysOnline" checked={settings.alwaysOnline} aria-describedby="online-help" />
                            Always show as online
                        </label>
                        <p id="online-help" class="text-sm text-slate-500 mt-2">
                            While connected, contacts see this number as online. Off keeps it offline, so the phone keeps receiving notifications.
                            Applies immediately to a connected instance.
                        </p>
                    </div>
                    <button type="submit" class="bg-slate-800 text-white rounded px-3 py-2">Save settings</button>
                </form>
            </main>
        </Layout>,
    );
}

export function dashboardPage(instances: Instance[]): string {
    return String(
        <Layout title="Dashboard — relaybox">
            <div class="max-w-3xl mx-auto mt-12">
                <div class="flex justify-between items-center mb-6">
                    <h1 class="text-2xl font-semibold">Instances</h1>
                    <button
                        hx-post="/logout"
                        hx-target="body"
                        class="bg-slate-800 text-white rounded px-3 py-2"
                    >
                        Logout
                    </button>
                </div>
                <button type="button" class="bg-slate-800 text-white rounded px-3 py-2 mb-6"
                    onclick="document.getElementById('create-instance-dialog').showModal()">
                    Create instance
                </button>
                <dialog id="create-instance-dialog" aria-labelledby="create-instance-title" class="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-lg max-h-[calc(100%-2rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl open:grid backdrop:bg-slate-900/50">
                    <CreateInstanceForm />
                </dialog>
                <div id="instances" class="bg-white rounded-lg shadow p-6 text-slate-500">
                    <InstanceList instances={instances} />
                </div>
            </div>
            <script
                dangerouslySetInnerHTML={{
                    __html: `
(function () {
    var svgCache = {};
    function renderQrs() {
        document.querySelectorAll('[data-qr]').forEach(function (el) {
            var data = el.dataset.qr;
            if (el.dataset.rendered === data) return;
            el.dataset.rendered = data;
            if (!svgCache[data]) {
                var qr = qrcode(0, 'L');
                qr.addData(data);
                qr.make();
                svgCache[data] = qr.createSvgTag(4, 2);
            }
            el.innerHTML = svgCache[data];
        });
    }
    document.body.addEventListener('htmx:afterSwap', renderQrs);
    var stream = new EventSource('/instances/events');
    stream.addEventListener('instances', function (event) {
        var instances = document.getElementById('instances');
        if (!instances) return;
        // The server JSON-encodes the fragment so it survives as one SSE data line.
        instances.innerHTML = JSON.parse(event.data);
        htmx.process(instances);
        renderQrs();
    });
    renderQrs();
})();`,
                }}
            ></script>
        </Layout>,
    );
}

export type WebhookFormValues = {
    url: string;
    enabled: boolean;
    byEvents: boolean;
    base64: boolean;
    events: string[];
    /** Names only: configured header values are secrets and are never rendered. */
    headerNames: string[];
    /** A new signing secret, or empty to keep the stored one; the stored value is never rendered. */
    signatureSecret: string;
    /** Whether deliveries include an HMAC signature. */
    signatureEnabled: boolean;
    /** Whether a secret is already stored; only a masked indicator is rendered. */
    hasSignatureSecret: boolean;
};

/** Nothing is configured yet, so nothing is enabled. */
export const EMPTY_WEBHOOK_FORM: WebhookFormValues = {
    url: '',
    enabled: false,
    byEvents: false,
    base64: false,
    events: [...SUPPORTED_EVENTS],
    headerNames: [],
    signatureSecret: '',
    signatureEnabled: false,
    hasSignatureSecret: false,
};

function Notice({ errors, saved }: { errors?: string[]; saved?: boolean }) {
    if (errors?.length) {
        return (
            <div class="mb-4 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <ul class="list-disc pl-4">
                    {errors.map((error) => (
                        <li>{error}</li>
                    ))}
                </ul>
            </div>
        );
    }
    if (saved) {
        return (
            <div class="mb-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                Webhook settings saved.
            </div>
        );
    }
    return null;
}

function WebhookForm({
    name,
    values,
    errors,
    saved,
}: {
    name: string;
    values: WebhookFormValues;
    errors?: string[];
    saved?: boolean;
}) {
    return (
        <form
            id="webhook-form"
            hx-post={`/instances/${name}/webhook`}
            hx-target="#webhook-form"
            hx-swap="outerHTML"
            class="bg-white rounded-lg shadow p-6"
        >
            <Notice errors={errors} saved={saved} />

            <label class="flex items-center gap-2 mb-4">
                <input type="checkbox" name="enabled" checked={values.enabled} />
                <span class="text-sm font-medium">Enabled</span>
            </label>

            <label class="block mb-4">
                <span class="text-sm font-medium">Callback URL</span>
                <input
                    name="url"
                    type="url"
                    value={values.url}
                    placeholder="https://consumer.example/webhooks/whatsapp"
                    required
                    class="mt-1 w-full border rounded px-3 py-2"
                />
            </label>

            <fieldset class="mb-4">
                <legend class="text-sm font-medium mb-2">Events</legend>
                <div class="grid grid-cols-2 gap-1">
                    {WEBHOOK_EVENTS.map((event) => (
                        <label class="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                name="events"
                                value={event}
                                checked={values.events.includes(event)}
                            />
                            <span>{event}</span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <label class="flex items-center gap-2 mb-2">
                <input type="checkbox" name="byEvents" checked={values.byEvents} />
                <span class="text-sm">Append the event name to the URL</span>
            </label>
            <label class="flex items-center gap-2 mb-4">
                <input type="checkbox" name="base64" checked={values.base64} />
                <span class="text-sm">Send media as base64</span>
            </label>

            <label class="block mb-4">
                <span class="text-sm font-medium">Custom headers (JSON)</span>
                <textarea
                    name="headers"
                    rows={3}
                    placeholder={'{ "X-Customer": "acme" }'}
                    class="mt-1 w-full border rounded px-3 py-2 font-mono text-sm"
                ></textarea>
                <span class="text-xs text-slate-500">
                    {values.headerNames.length
                        ? `Currently set: ${values.headerNames.join(', ')} (values hidden). Leave empty to keep them.`
                        : 'Leave empty to keep the stored headers.'}
                </span>
            </label>

            <label class="flex items-center gap-2 mb-2">
                <input type="checkbox" name="signatureEnabled" checked={values.signatureEnabled} />
                <span class="text-sm">Sign webhook deliveries</span>
            </label>

            <label class="block mb-4">
                <span class="text-sm font-medium">Signing secret</span>
                <div class="mt-1 flex gap-2">
                    <input
                        name="signatureSecret"
                        type="password"
                        autocomplete="new-password"
                        value={values.signatureSecret}
                        placeholder="HMAC secret for X-Webhook-Signature"
                        minlength={16}
                        data-signature-secret
                        class="min-w-0 flex-1 border rounded px-3 py-2"
                    />
                    <button
                        type="button"
                        data-generate-signature-secret
                        class="shrink-0 rounded bg-slate-200 px-3 py-2 text-sm text-slate-800 hover:bg-slate-300"
                    >
                        Generate
                    </button>
                </div>
                <span class="text-xs text-slate-500">
                    {values.hasSignatureSecret
                        ? 'A signing secret is already configured (••••••••). Leave this empty to keep it.'
                        : 'Required when signing is enabled; use at least 16 characters.'}{' '}
                    Deliveries use an HMAC-SHA256 of the body; consumers verify it with the same secret.
                </span>
            </label>

            <button type="submit" class="bg-slate-800 text-white rounded px-3 py-2">
                Save
            </button>
        </form>
    );
}

/** htmx fragment: the webhook form, swapped in place after a save. */
export function webhookForm(
    name: string,
    values: WebhookFormValues,
    state: { errors?: string[]; saved?: boolean } = {},
): string {
    return String(<WebhookForm name={name} values={values} errors={state.errors} saved={state.saved} />);
}

const DELIVERY_TONES: Record<string, Tone> = {
    delivered: 'emerald',
    pending: 'amber',
    failed: 'rose',
};

function DeliveryRow({ delivery }: { delivery: DeliveryHistoryEntry }) {
    const at = delivery.deliveredAt ?? delivery.createdAt;

    return (
        <tr class="border-t align-top">
            <td class="py-2 pr-3">
                <Badge tone={DELIVERY_TONES[delivery.status] ?? 'slate'}>{delivery.status}</Badge>
            </td>
            <td class="py-2 pr-3 font-medium">{delivery.event}</td>
            <td class="py-2 pr-3 tabular-nums">{delivery.responseStatus ?? '—'}</td>
            <td class="py-2 pr-3 tabular-nums">{String(delivery.attempts)}</td>
            <td class="py-2 pr-3 text-slate-500 whitespace-nowrap">{at.toISOString().replace('T', ' ').slice(0, 19)}</td>
            {/* Our own error text, never the response body, which could echo a secret. */}
            <td class="py-2 text-rose-700">{delivery.lastError ?? ''}</td>
        </tr>
    );
}

/**
 * Delivery history. The payload and the per-delivery URL are deliberately absent: the
 * first carries message content and the envelope apikey, the second can carry a token in
 * its path. What is left is enough to tell whether a consumer is accepting deliveries.
 */
function DeliveryHistory({ deliveries }: { deliveries: DeliveryHistoryEntry[] }) {
    if (!deliveries.length) {
        return <p class="text-sm text-slate-500">No deliveries yet.</p>;
    }

    return (
        <div class="overflow-x-auto">
            <table class="w-full text-sm text-left">
                <thead class="text-xs uppercase text-slate-500">
                    <tr>
                        <th class="pb-2 pr-3 font-medium">Status</th>
                        <th class="pb-2 pr-3 font-medium">Event</th>
                        <th class="pb-2 pr-3 font-medium">Response</th>
                        <th class="pb-2 pr-3 font-medium">Attempts</th>
                        <th class="pb-2 pr-3 font-medium">When</th>
                        <th class="pb-2 font-medium">Error</th>
                    </tr>
                </thead>
                <tbody>
                    {deliveries.map((delivery) => (
                        <DeliveryRow delivery={delivery} />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function webhookPage(name: string, values: WebhookFormValues, deliveries: DeliveryHistoryEntry[] = []): string {
    return String(
        <Layout title={`Webhook — ${name}`}>
            <div class="max-w-3xl mx-auto mt-12">
                <div class="flex justify-between items-center mb-6">
                    <h1 class="text-2xl font-semibold">Webhook — {name}</h1>
                    <a href="/dashboard" class="text-sm text-slate-600 hover:underline">
                        Back to instances
                    </a>
                </div>
                <WebhookForm name={name} values={values} />
                <div
                    id="generated-signature-secret"
                    hidden
                    role="status"
                    class="mt-4 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
                >
                    <p class="font-medium">Generated signing secret</p>
                    <p class="mt-1">Copy it now. It remains visible only until you refresh, leave, or close this page.</p>
                    <div class="mt-3 flex flex-wrap items-center gap-2">
                        <code id="generated-signature-secret-value" class="break-all rounded bg-white px-2 py-1 font-mono text-xs"></code>
                        <button
                            type="button"
                            data-copy-generated-signature-secret
                            class="rounded bg-amber-700 px-3 py-1.5 text-sm text-white hover:bg-amber-800"
                        >
                            Copy
                        </button>
                        <span data-copy-generated-signature-secret-status aria-live="polite"></span>
                    </div>
                </div>
                <div class="bg-white rounded-lg shadow p-6 mt-6">
                    <h2 class="text-lg font-semibold mb-4">Recent deliveries</h2>
                    <DeliveryHistory deliveries={deliveries} />
                </div>
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(function () {
    function generateSecret() {
        var bytes = new Uint8Array(24);
        window.crypto.getRandomValues(bytes);
        var binary = '';
        bytes.forEach(function (byte) { binary += String.fromCharCode(byte); });
        return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }

    function copySecret(secret) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(secret);
        }
        var temporary = document.createElement('textarea');
        temporary.value = secret;
        temporary.style.position = 'fixed';
        temporary.style.opacity = '0';
        document.body.appendChild(temporary);
        temporary.select();
        document.execCommand('copy');
        temporary.remove();
        return Promise.resolve();
    }

    document.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;

        if (target.closest('[data-generate-signature-secret]')) {
            var form = target.closest('form');
            var input = form && form.querySelector('[data-signature-secret]');
            var enabled = form && form.querySelector('[name="signatureEnabled"]');
            var disclosure = document.getElementById('generated-signature-secret');
            var value = document.getElementById('generated-signature-secret-value');
            if (!input || !disclosure || !value) return;

            var secret = generateSecret();
            input.value = secret;
            if (enabled) enabled.checked = true;
            value.textContent = secret;
            disclosure.hidden = false;
            return;
        }

        if (target.closest('[data-copy-generated-signature-secret]')) {
            var value = document.getElementById('generated-signature-secret-value');
            var status = document.querySelector('[data-copy-generated-signature-secret-status]');
            if (!value || !value.textContent) return;
            copySecret(value.textContent).then(function () {
                if (status) status.textContent = 'Copied.';
            }).catch(function () {
                if (status) status.textContent = 'Copy failed. Select the secret and copy it manually.';
            });
        }
    });
})();`,
                    }}
                ></script>
            </div>
        </Layout>,
    );
}

function timeLabel(seconds: number): string {
    return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

function chatTimeLabel(date: Date | null): string | null {
    return date ? date.toISOString().slice(11, 16) : null;
}

function ChatAvatar({ name, jid, label }: { name: string; jid: string; label: string }) {
    const initial = label.trim().charAt(0).toUpperCase() || '?';

    return (
        <span class="relative shrink-0 w-12 h-12 rounded-full overflow-hidden bg-slate-200 text-slate-600 flex items-center justify-center font-medium text-lg">
            <span>{initial}</span>
            <img
                src={`/instances/${name}/chats/avatar?jid=${encodeURIComponent(jid)}`}
                alt=""
                class="absolute inset-0 w-full h-full object-cover"
                onerror="this.remove()"
            />
        </span>
    );
}

function ChatListItem({ name, chat, selected }: { name: string; chat: ChatSummary; selected?: string }) {
    const active = chat.remoteJid === selected;
    const label = chat.name ?? chat.remoteJid;

    return (
        <a
            href={`/instances/${name}/chats?jid=${encodeURIComponent(chat.remoteJid)}`}
            class={`flex gap-3 border-b border-slate-100 border-l-4 px-4 py-3 hover:bg-slate-50 ${
                active ? 'border-l-slate-800 bg-slate-100' : 'border-l-transparent'
            }`}
        >
            <ChatAvatar name={name} jid={chat.remoteJid} label={label} />
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <div class="min-w-0 flex-1 font-medium truncate">{label}</div>
                    {chatTimeLabel(chat.lastMessageAt) ? (
                        <span class="shrink-0 text-xs text-slate-400">{chatTimeLabel(chat.lastMessageAt)}</span>
                    ) : null}
                </div>
                <div class="mt-1 text-sm text-slate-500 truncate">{chat.lastMessagePreview ?? 'No messages yet'}</div>
            </div>
        </a>
    );
}

/**
 * One message. `text` is the only thing lifted out of the stored payload, and everything
 * else is described by its type, so no raw Baileys content or media key can reach the page.
 * A message with a downloaded file shows it; the URL is deterministic from name and key.
 */
function MessageBubble({ name, message, showSender }: { name: string; message: ChatMessage; showSender?: boolean }) {
    const mine = message.fromMe;
    const { mediaType } = message;
    const mediaUrl = mediaType ? `/instances/${name}/media/${message.keyId}` : undefined;

    return (
        <div class={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
            <div
                class={`max-w-[80%] border px-4 py-2 shadow-sm ${
                    mine
                        ? 'rounded-2xl rounded-tr-sm border-slate-700 bg-slate-800 text-white'
                        : 'rounded-2xl rounded-tl-sm border-slate-200 bg-white text-slate-900'
                }`}
            >
                {/* In a group, who spoke is not obvious from the chat itself. */}
                {showSender && !mine && message.pushName ? (
                    <div class="mb-1 text-xs font-medium text-sky-700">{message.pushName}</div>
                ) : null}
                {mediaType && mediaUrl ? mediaElement(mediaType, mediaUrl) : null}
                {message.text ? (
                    <div class="whitespace-pre-wrap break-words">{message.text}</div>
                ) : mediaUrl ? null : (
                    <div class="italic text-slate-500">{message.status === 'DELETED' ? 'Deleted' : message.messageType}</div>
                )}
                <div class={`mt-1 text-right text-xs ${mine ? 'text-slate-300' : 'text-slate-400'}`}>
                    {timeLabel(message.messageTimestamp)}
                    <span id={`message-status-${message.keyId}`}>{message.status ? ` · ${message.status}` : ''}</span>
                </div>
            </div>
        </div>
    );
}

/** The player or link for a downloaded media file. */
function mediaElement(mediaType: NonNullable<ChatMessage['mediaType']>, url: string) {
    switch (mediaType) {
        case 'image':
            return <img src={url} alt="" loading="lazy" class="rounded max-w-72 max-h-72" />;
        case 'video':
            return <video src={url} controls class="rounded max-w-72" />;
        case 'audio':
            return <audio src={url} controls />;
        case 'file':
            return (
                <a href={url} class="text-sky-700 underline">
                    Download document
                </a>
            );
    }
}

/** htmx fragment: one page of history, oldest first, with a button for the page before it. */
export function messageTimeline(name: string, jid: string, page: MessagePage): string {
    return String(<Timeline name={name} jid={jid} page={page} />);
}

function Composer({ name, jid, error, draft }: { name: string; jid: string; error?: string; draft?: string }) {
    return (
        <form
            hx-post={`/instances/${name}/chats/send`}
            hx-target="#chat-timeline"
            hx-swap="beforeend"
            class="shrink-0 border-t border-slate-200 bg-white p-4"
            {...{ 'hx-on::after-request': "this.reset(); this.querySelector('textarea').style.height = ''" }}
        >
            <input type="hidden" name="jid" value={jid} />
            <div class="flex items-end gap-2">
                {/* A failed send hands the text back rather than making it be retyped. */}
                <textarea
                    name="text"
                    placeholder="Write a reply…"
                    required
                    autocomplete="off"
                    rows={1}
                    oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'"
                    class="min-h-12 max-h-36 flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-3 focus:border-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-200"
                >
                    {draft ?? ''}
                </textarea>
                <button type="submit" class="h-12 shrink-0 rounded-xl bg-slate-800 px-5 font-medium text-white hover:bg-slate-700">
                    Send
                </button>
            </div>
            {error ? <p class="mt-2 text-sm text-rose-600">{error}</p> : null}
        </form>
    );
}

/**
 * htmx fragment: the whole conversation panel. Sending swaps this so the reply appears and
 * the box clears, without reloading the chat list beside it.
 */
export function conversationPanel(
    name: string,
    jid: string,
    page: MessagePage,
    state: { error?: string; draft?: string } = {},
): string {
    return String(<Conversation name={name} jid={jid} page={page} {...state} />);
}

function Conversation({
    name,
    jid,
    page,
    error,
    draft,
}: {
    name: string;
    jid: string;
    page: MessagePage;
    error?: string;
    draft?: string;
}) {
    return (
        <div
            id="conversation"
            class="flex min-h-0 flex-1 flex-col"
            data-chat-events={`/instances/${name}/chats/events?jid=${encodeURIComponent(jid)}`}
        >
            <div class="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
                <a href={`/instances/${name}/chats`} class="text-sm text-slate-500 hover:text-slate-900 md:hidden">
                    Back
                </a>
                <ChatAvatar name={name} jid={jid} label={jid} />
                <div class="min-w-0 flex-1 font-medium truncate">{jid}</div>
            </div>
            <div id="chat-timeline" class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-6">
                <Timeline name={name} jid={jid} page={page} />
            </div>
            <Composer name={name} jid={jid} error={error} draft={draft} />
        </div>
    );
}

function Timeline({ name, jid, page }: { name: string; jid: string; page: MessagePage }) {
    if (!page.messages.length) {
        return <p class="text-sm text-slate-500">No messages in this chat yet.</p>;
    }

    return (
        <>
            {page.cursor ? (
                <div id={`older-${page.cursor}`} class="text-center mb-3">
                    <button
                        hx-get={`/instances/${name}/chats/messages?jid=${encodeURIComponent(jid)}&before=${encodeURIComponent(page.cursor)}`}
                        hx-target={`#older-${page.cursor}`}
                        hx-swap="outerHTML"
                        class="text-sm text-slate-600 hover:underline"
                    >
                        Load older messages
                    </button>
                </div>
            ) : null}
            {page.messages.map((message) => (
                <MessageBubble name={name} message={message} showSender={jid.endsWith('@g.us')} />
            ))}
        </>
    );
}

export function chatsPage(
    name: string,
    chats: ChatSummary[],
    selected: string | undefined,
    page: MessagePage,
): string {
    return String(
        <Layout title={`Chats — ${name}`}>
            <div class="mx-auto p-4 lg:max-w-7xl lg:py-8">
                <div class="flex h-[calc(100vh-2rem)] min-h-[36rem] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:h-[min(800px,calc(100vh-4rem))]">
                    <header class="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-4 sm:px-6">
                        <h1 class="text-xl font-semibold text-slate-900">Chats — {name}</h1>
                        <a href="/dashboard" class="text-sm text-slate-600 hover:text-slate-900 hover:underline">
                            Back to instances
                        </a>
                    </header>
                    <div class="flex min-h-0 flex-1">
                        <aside
                            class={`min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-80 ${
                                selected ? 'hidden' : 'flex'
                            }`}
                        >
                            <div class="shrink-0 border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-600">
                                Conversations
                            </div>
                            <div class="min-h-0 flex-1 overflow-y-auto">
                                {chats.length ? (
                                    chats.map((chat) => <ChatListItem name={name} chat={chat} selected={selected} />)
                                ) : (
                                    <p class="p-4 text-sm text-slate-500">No chats yet.</p>
                                )}
                            </div>
                        </aside>
                        <section class={`min-w-0 flex-1 flex-col bg-slate-50 ${selected ? 'flex' : 'hidden md:flex'}`}>
                            {selected ? (
                                <Conversation name={name} jid={selected} page={page} />
                            ) : (
                                <p class="m-auto text-sm text-slate-500">Pick a chat to read it.</p>
                            )}
                        </section>
                    </div>
                </div>
            </div>
        </Layout>,
    );
}
