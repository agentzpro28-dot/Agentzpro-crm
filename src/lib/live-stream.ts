/**
 * One live connection (/api/dashboard/stream) per browser tab, shared by everything that listens to it: the
 * shell's alerts provider, the dashboard and an open lead's timeline. Each of them used to open its own, so a
 * Dashboard view or an open lead drawer held two long-lived requests, each with its own access re-check every
 * 280 s and its own share of the per-user stream limit.
 *
 * openLiveStream() returns a handle that looks like an EventSource (addEventListener, onerror, readyState,
 * close), so every caller keeps its own reconnect, fallback-polling and catch-up rules unchanged:
 * - Every handle receives every event and error of the shared connection.
 * - A new real connection opens only when there is none or the browser gave up on it (CLOSED). Handles still
 *   attached then receive the new connection's events too.
 * - A handle that joins an already-connected stream gets this connection's "ready" and latest "status" replayed,
 *   in the order they arrived, because the server sent them before it was listening.
 * - The real connection closes when the last handle closes. Every caller closes its handle while the tab is
 *   hidden, so a background tab holds no connection; a caller that kept its handle would keep the tab connected.
 */

const STREAM_URL = "/api/dashboard/stream";
// EventSource's readyState values, kept here so this module never reads the global (tests remove it on teardown).
const CONNECTING = 0;
const CLOSED = 2;
/** Events about the connection itself, remembered so a late joiner learns the current state. */
const STATE_EVENTS = ["ready", "status"] as const;

type Listener = (event: MessageEvent<string>) => void;

export interface LiveStream {
  addEventListener(name: string, listener: Listener): void;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

let source: EventSource | null = null;
let boundNames = new Set<string>();
/** "ready" and "status" events of the current connection, in arrival order (at most one of each). */
let stateEvents: { name: string; event: MessageEvent<string> }[] = [];
const handles = new Set<Handle>();

class Handle implements LiveStream {
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Listener[]>();
  private closed = false;

  addEventListener(name: string, listener: Listener): void {
    if (this.closed) return;
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    bind(name);
  }

  get readyState(): number {
    return this.closed || !source ? CLOSED : source.readyState ?? CONNECTING;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.onerror = null;
    handles.delete(this);
    if (handles.size === 0) disconnect();
  }

  deliver(name: string, event: MessageEvent<string>): void {
    if (this.closed) return;
    for (const listener of this.listeners.get(name) ?? []) isolate(() => listener(event));
  }

  fail(event: Event): void {
    const onerror = this.onerror;
    if (!this.closed && onerror) isolate(() => onerror(event));
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Runs one listener so that its exception is reported but never stops the other listeners, as with separate
 * EventSources (a page's broken handler must not cost the bell its reminders).
 */
function isolate(run: () => void): void {
  try {
    run();
  } catch (error) {
    if (typeof reportError === "function") reportError(error);
    else console.error(error);
  }
}

function bind(name: string): void {
  const current = source;
  if (!current || boundNames.has(name)) return;
  boundNames.add(name);
  current.addEventListener(name, (event) => {
    if (source !== current) return;
    const message = event as MessageEvent<string>;
    if ((STATE_EVENTS as readonly string[]).includes(name)) {
      stateEvents = [...stateEvents.filter((entry) => entry.name !== name), { name, event: message }];
    }
    for (const handle of [...handles]) handle.deliver(name, message);
  });
}

function connect(): void {
  const previous = source;
  const names = new Set([...STATE_EVENTS, ...boundNames]);
  previous?.close();
  const next = new EventSource(STREAM_URL);
  source = next;
  boundNames = new Set();
  stateEvents = [];
  for (const name of names) bind(name);
  next.onerror = (event) => {
    if (source !== next) return;
    // Any reconnect starts with a fresh "ready" (and status), so nothing from the old connection is replayed.
    stateEvents = [];
    for (const handle of [...handles]) handle.fail(event);
  };
}

function disconnect(): void {
  source?.close();
  source = null;
  boundNames = new Set();
  stateEvents = [];
}

/** Joins this tab's live connection, opening it if there is none or the browser gave up on the last one. */
export function openLiveStream(): LiveStream {
  const handle = new Handle();
  handles.add(handle);
  if (!source || source.readyState === CLOSED) {
    connect();
    return handle;
  }
  const joinedSource = source;
  const replay = stateEvents;
  if (replay.length > 0) {
    // After the caller has attached its listeners (they do so right after this returns).
    queueMicrotask(() => {
      if (handle.isClosed || source !== joinedSource) return;
      for (const { name, event } of replay) handle.deliver(name, event);
    });
  }
  return handle;
}
