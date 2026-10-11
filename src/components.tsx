/**
 * Shared markup components. Interactivity is expressed as htmx attributes so
 * these stay plain server-rendered HTML with no client-side runtime.
 *
 * Browse them at /ui while developing.
 */

export function Layout({ title, children }: { title: string; children?: unknown }) {
    return (
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>{title}</title>
                <link rel="stylesheet" href="/styles.css" />
                <script src="https://unpkg.com/htmx.org@2"></script>
                {/*
                 * htmx swaps only 2xx by default, so a rendered form error would be thrown
                 * away and the user would see nothing happen. 400 is how every form here
                 * reports invalid input, so let that one swap; a 500 stays unswapped rather
                 * than splattering an error page into the target.
                 */}
                <script
                    dangerouslySetInnerHTML={{
                        __html: `htmx.config.responseHandling = [
    { code: '204', swap: false },
    { code: '[23]..', swap: true },
    { code: '400', swap: true, error: true },
    { code: '429', swap: true, error: true },
    { code: '[45]..', swap: false, error: true },
];`,
                    }}
                ></script>
                <script src="https://unpkg.com/qrcode-generator@1.4.4/qrcode.js"></script>
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(() => {
    let stream;
    let streamUrl;
    const connectChatEvents = () => {
        const conversation = document.getElementById('conversation');
        const url = conversation?.dataset.chatEvents;
        if (!url || url === streamUrl) return;
        stream?.close();
        streamUrl = url;
        stream = new EventSource(url);
        stream.addEventListener('message-status', ({ data }) => {
            const { keyId, status } = JSON.parse(data);
            const label = document.getElementById('message-status-' + keyId);
            if (label) label.textContent = ' · ' + status;
        });
    };
    document.addEventListener('DOMContentLoaded', () => {
        connectChatEvents();
        const timeline = document.getElementById('chat-timeline');
        if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
    // document.body doesn't exist yet: this script runs from <head>, before body is parsed.
    document.addEventListener('htmx:afterSettle', connectChatEvents);
})();`,
                    }}
                ></script>
            </head>
            <body class="bg-slate-100 min-h-screen">{children}</body>
        </html>
    );
}

export type Tone = 'slate' | 'amber' | 'sky' | 'emerald' | 'rose';

// Written out in full because Tailwind scans source for literal class names.
const BADGE_TONES: Record<Tone, string> = {
    slate: 'bg-slate-100 text-slate-800',
    amber: 'bg-amber-100 text-amber-800',
    sky: 'bg-sky-100 text-sky-800',
    emerald: 'bg-emerald-100 text-emerald-800',
    rose: 'bg-rose-100 text-rose-800',
};

export function Badge({ tone = 'slate', children }: { tone?: Tone; children?: unknown }) {
    return <span class={`text-xs px-2 py-1 rounded ${BADGE_TONES[tone]}`}>{children}</span>;
}

/**
 * Menu built on <details>, so opening and closing needs no JavaScript.
 *
 * A poller that re-renders the dropdown will close it mid-click; filter the
 * poll with `[!this.querySelector('details[open]')]` where that applies.
 */
export function Dropdown({ label = '⋯', children }: { label?: string; children?: unknown }) {
    return (
        <details class="relative">
            <summary class="list-none cursor-pointer select-none rounded px-2 py-1 text-slate-500 hover:bg-slate-100">
                {label}
            </summary>
            <div class="absolute right-0 z-10 mt-1 w-52 rounded border bg-white py-1 shadow-lg">
                {children}
            </div>
        </details>
    );
}

const ITEM_TONES: Record<Tone, string> = {
    slate: 'text-slate-700',
    amber: 'text-amber-700',
    sky: 'text-sky-700',
    emerald: 'text-emerald-700',
    rose: 'text-rose-600',
};

/** A dropdown entry that POSTs to `post` and swaps the response into `target`. */
export function DropdownItem({
    post,
    target,
    confirm,
    prompt,
    tone = 'slate',
    children,
}: {
    post: string;
    target: string;
    confirm?: string;
    /** Asks for a value and sends it in the `HX-Prompt` header. */
    prompt?: string;
    tone?: Tone;
    children?: unknown;
}) {
    return (
        <button
            type="button"
            hx-post={post}
            hx-target={target}
            hx-confirm={confirm}
            hx-prompt={prompt}
            class={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 ${ITEM_TONES[tone]}`}
        >
            {children}
        </button>
    );
}

/** A dropdown entry that navigates instead of posting. */
export function DropdownLink({ href, tone = 'slate', children }: { href: string; tone?: Tone; children?: unknown }) {
    return (
        <a
            href={href}
            class={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 ${ITEM_TONES[tone]}`}
        >
            {children}
        </a>
    );
}
