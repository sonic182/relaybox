import { Badge, Dropdown, DropdownItem, Layout, type Tone } from './components';

const TONES: Tone[] = ['slate', 'amber', 'sky', 'emerald', 'rose'];

function Section({ title, note, children }: { title: string; note: string; children?: unknown }) {
    return (
        <section class="mb-8 rounded-lg bg-white p-6 shadow">
            <h2 class="font-semibold">{title}</h2>
            <p class="mb-4 text-sm text-slate-500">{note}</p>
            {children}
        </section>
    );
}

/** Dev-only gallery of the components in src/components.tsx. */
export function uiPage(): string {
    return String(
        <Layout title="Components — relaybox">
            <div class="mx-auto mt-12 max-w-3xl">
                <h1 class="mb-6 text-2xl font-semibold">Components</h1>

                <Section title="Badge" note="Status pill. One tone per state.">
                    <div class="flex flex-wrap gap-2">
                        {TONES.map((tone) => (
                            <Badge tone={tone}>{tone}</Badge>
                        ))}
                    </div>
                </Section>

                <Section
                    title="Dropdown"
                    note="Built on <details>, so it opens and closes with no JavaScript. Items POST via htmx and swap the response into their target — these post to /ui/demo and swap the result below."
                >
                    <div class="flex justify-end">
                        <Dropdown>
                            <DropdownItem post="/ui/demo" target="#demo-target">
                                Plain item
                            </DropdownItem>
                            <DropdownItem post="/ui/demo" target="#demo-target" tone="emerald">
                                Toned item
                            </DropdownItem>
                            <DropdownItem
                                post="/ui/demo"
                                target="#demo-target"
                                confirm="Confirm this destructive action?"
                                tone="rose"
                            >
                                Item with confirm
                            </DropdownItem>
                        </Dropdown>
                    </div>
                    <div id="demo-target" class="mt-4 text-sm text-slate-500">
                        No item clicked yet.
                    </div>
                </Section>

                <Section
                    title="Dropdown inside a poller"
                    note="A poll that re-renders an open menu closes it mid-click. Scope the poll to its own subtree so it pauses while a menu inside it is open. Open the menu below: the clock stops until you close it."
                >
                    <div
                        id="poller"
                        hx-get="/ui/tick"
                        hx-trigger="every 1s [!this.querySelector('details[open]')]"
                    >
                        <Tick />
                    </div>
                </Section>

            </div>
        </Layout>,
    );
}

/** Body of the polling demo: a clock that visibly stalls while its menu is open. */
function Tick() {
    return (
        <div class="flex items-center justify-between">
            <span class="font-mono text-sm text-slate-600">
                {new Date().toISOString().slice(11, 23)}
            </span>
            <Dropdown>
                <DropdownItem post="/ui/demo" target="#demo-target">
                    The clock is paused
                </DropdownItem>
                <DropdownItem post="/ui/demo" target="#demo-target">
                    while this is open
                </DropdownItem>
            </Dropdown>
        </div>
    );
}

export function uiTick(): string {
    return String(<Tick />);
}

export function uiDemoResponse(): string {
    return String(
        <div class="text-sm text-emerald-700">Item clicked at {new Date().toISOString()}</div>,
    );
}
