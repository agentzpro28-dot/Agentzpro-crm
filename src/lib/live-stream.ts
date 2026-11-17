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
 * - Handover: the server ends every stream after a few minutes and says "rollover" shortly before. While the
 *   connection is live, the next one is then opened beside it and takes over once it says "ready" and then "live".
 *   The handles get its "ready" and "status" as after a reconnect, but no error, so no page reloads to catch up on a
 *   signal it might have missed in between. The old connection keeps delivering for a moment after the switch, so a
 *   signal it was already carrying still arrives (the pages absorb a duplicate). Whenever the next connection is in
 *   doubt (an error, a refusal such as 401 or 429, "degraded", too slow, the old one ending first, the tab hidden) it
 *   is closed without telling any handle, and the old one ends and reconnects exactly as before.
 */

const STREAM_URL = "/api/dashboard/stream";
// EventSource's readyState values, kept here so this module never reads the global (tests remove it on teardown).
const CONNECTING = 0;
const CLOSED = 2;
/** Events about the connection itself, remembered so a late joiner learns the current state. */
const STATE_EVENTS = ["ready", "status"] as const;
/** Sent by the server shortly before it ends a stream (ROLLOVER_NOTICE_MS in the stream route, 10 s). */
const ROLLOVER_EVENT = "rollover";
/** How long the old connection keeps delivering signals after a handover. */
const HANDOVER_OVERLAP_MS = 2_000;
/** A next connection that is not live by then is dropped; the old one has ended by then and reconnects as before. */
const HANDOVER_TIMEOUT_MS = 15_000;

type Listener = (event: MessageEvent<string>) => void;
type StateEntry = { name: string; event: MessageEvent<string> };

export interface LiveStream {
  addEventListener(name: string, listener: Listener): void;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

let source: EventSource | null = null;
let boundNames = new Set<string>();
/** "ready" and "status" events of the current connection, in arrival order (at most one of each). */
let stateEvents: StateEntry[] = [];
const handles = new Set<Handle>();
/** The next connection while a handover is under way, and the "ready" it has sent so far. */
let handover: { source: EventSource; ready: StateEntry | null; timer: ReturnType<typeof setTimeout> } | null = null;
/** The previous connection during the overlap after a handover. */
let draining: { source: EventSource; timer: ReturnType<typeof setTimeout> } | null = null;

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

function deliverToAll(name: string, event: MessageEvent<string>): void {
  for (const handle of [...handles]) handle.deliver(name, event);
}

function isState(name: string): boolean {
  return (STATE_EVENTS as readonly string[]).includes(name);
}

function remember(entry: StateEntry): void {
  stateEvents = [...stateEvents.filter((existing) => existing.name !== entry.name), entry];
}

function bind(name: string): void {
  const current = source;
  if (!current || boundNames.has(name)) return;
  boundNames.add(name);
  current.addEventListener(name, (event) => {
    const message = event as MessageEvent<string>;
    if (source !== current) {
      // The old connection right after a handover: its signals still count, its connection state no longer does.
      if (draining?.source === current && !isState(name)) deliverToAll(name, message);
      return;
    }
    if (isState(name)) remember({ name, event: message });
    deliverToAll(name, message);
  });
}

/** Makes `next` the connection every handle listens to. */
function adopt(next: EventSource, names: Set<string>): void {
  source = next;
  boundNames = new Set();
  stateEvents = [];
  for (const name of names) bind(name);
  next.addEventListener(ROLLOVER_EVENT, () => { if (source === next) startHandover(); });
  next.onerror = (event) => {
    if (source !== next) {
      // The old connection ended during the overlap: close it before the browser reconnects it.
      if (draining?.source === next) endOverlap();
      return;
    }
    // The current connection dropped, so a handover still under way goes with it: this is the reconnect path.
    dropHandover();
    // Any reconnect starts with a fresh "ready" (and status), so nothing from the old connection is replayed.
    stateEvents = [];
    for (const handle of [...handles]) handle.fail(event);
  };
}

function connect(): void {
  const names = new Set([...STATE_EVENTS, ...boundNames]);
  source?.close();
  dropHandover();
  endOverlap();
  adopt(new EventSource(STREAM_URL), names);
}

function readState(event: MessageEvent<string>): unknown {
  try {
    return (JSON.parse(event.data) as { state?: unknown } | null)?.state;
  } catch {
    return undefined;
  }
}

/** Whether the current connection's latest status says "live". */
function currentIsLive(): boolean {
  const status = stateEvents.find((entry) => entry.name === "status");
  return status !== undefined && readState(status.event) === "live";
}

/** The server said "rollover": open the next connection, but only when this one is live (otherwise: as before). */
function startHandover(): void {
  if (handover || handles.size === 0 || !currentIsLive()) return;
  const next = new EventSource(STREAM_URL);
  handover = { source: next, ready: null, timer: setTimeout(dropHandover, HANDOVER_TIMEOUT_MS) };
  const pending = () => (handover?.source === next ? handover : null);
  next.addEventListener("ready", (event) => {
    const current = pending();
    if (current) current.ready = { name: "ready", event: event as MessageEvent<string> };
  });
  next.addEventListener("status", (event) => {
    const current = pending();
    if (!current) return;
    const message = event as MessageEvent<string>;
    // The current one must still be live at the switch: one that stopped meanwhile may have missed a signal, which
    // only the old path's reconnect (an error, then each page's catch-up) makes up for.
    if (current.ready && readState(message) === "live" && currentIsLive()) completeHandover(next, current.ready, { name: "status", event: message });
    else dropHandover();
  });
  // Any error, including a refusal (401, 429) that makes the browser give up: drop it, no handle is told.
  next.onerror = () => { if (pending()) dropHandover(); };
}

function completeHandover(next: EventSource, ready: StateEntry, status: StateEntry): void {
  const previous = source;
  if (handover) clearTimeout(handover.timer);
  handover = null;
  endOverlap();
  adopt(next, new Set([...STATE_EVENTS, ...boundNames]));
  if (previous) draining = { source: previous, timer: setTimeout(endOverlap, HANDOVER_OVERLAP_MS) };
  // As after a reconnect: the new connection's "ready" and "status", in that order, but no error.
  for (const entry of [ready, status]) {
    if (source !== next) return;
    remember(entry);
    deliverToAll(entry.name, entry.event);
  }
}

function dropHandover(): void {
  if (!handover) return;
  clearTimeout(handover.timer);
  handover.source.close();
  handover = null;
}

function endOverlap(): void {
  if (!draining) return;
  clearTimeout(draining.timer);
  draining.source.close();
  draining = null;
}

function disconnect(): void {
  dropHandover();
  endOverlap();
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
