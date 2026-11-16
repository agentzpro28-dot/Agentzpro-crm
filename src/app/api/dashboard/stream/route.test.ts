// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/dashboard-live-relay", () => ({ subscribeToTenantChanges: mocks.subscribe }));

import { GET } from "./route";

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }
  return received;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/dashboard/stream", () => {
  it("subscribes only to the session's own tenant and announces it", async () => {
    const unsubscribe = vi.fn();
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.subscribe.mockReturnValue(unsubscribe);
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream?tenantId=tenant-b", { signal: abort.signal }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toMatch(/no-cache/);
    const reader = response.body!.getReader();
    const first = await readUntil(reader, "event: ready");
    expect(first).toContain('"tenantId":"tenant-a"');
    expect(mocks.subscribe).toHaveBeenCalledWith("tenant-a", expect.any(Function));
    expect(mocks.subscribe).not.toHaveBeenCalledWith("tenant-b", expect.anything());
    abort.abort();
    await reader.cancel().catch(() => {});
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("relays change and degraded/live status events without any lead data", async () => {
    let emit: (event: "change" | "degraded" | "live") => void = () => {};
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.subscribe.mockImplementation((_tenant: string, listener: typeof emit) => { emit = listener; return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    emit("change");
    expect(await readUntil(reader, "event: change")).toContain("event: change\ndata: {}");
    emit("degraded");
    expect(await readUntil(reader, "degraded")).toContain('event: status\ndata: {"state":"degraded"}');
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("sends ready before the state a late joiner is told at once, so a degraded channel is not cancelled by ready", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-late" });
    // The relay tells a stream joining an already-degraded channel so, synchronously, while it subscribes.
    mocks.subscribe.mockImplementation((_tenant: string, listener: (event: "degraded") => void) => { listener("degraded"); return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    const received = await readUntil(reader, '"state":"degraded"');
    expect(received).toContain("event: ready");
    expect(received.indexOf("event: ready")).toBeLessThan(received.indexOf('event: status\ndata: {"state":"degraded"}'));
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("forwards an update's newest saved time with its change event, and nothing else", async () => {
    let emit: (event: "change", payload?: { newestSavedUs?: string; leadId?: string }) => void = () => {};
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-update" });
    mocks.subscribe.mockImplementation((_tenant: string, listener: typeof emit) => { emit = listener; return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    emit("change", { newestSavedUs: "1793859911562817", leadId: "11111111-1111-4111-8111-111111111111" });
    const received = await readUntil(reader, "event: change");
    expect(received).toContain('event: change\ndata: {"kind":"update","newestSavedUs":"1793859911562817"}');
    expect(received).not.toContain("leadId");
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("forwards a timeline activity as an activity event carrying only the lead id", async () => {
    let emit: (event: "change" | "degraded" | "live" | "activity", payload?: { leadId: string }) => void = () => {};
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-activity" });
    mocks.subscribe.mockImplementation((_tenant: string, listener: typeof emit) => { emit = listener; return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    emit("activity", { leadId: "11111111-1111-4111-8111-111111111111" });
    expect(await readUntil(reader, "event: activity")).toContain('event: activity\ndata: {"leadId":"11111111-1111-4111-8111-111111111111"}');
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("delivers a task reminder only to the member it is for", async () => {
    let emit: (event: "reminder", payload?: { notificationId: string; userId: string }) => void = () => {};
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-me" });
    mocks.subscribe.mockImplementation((_tenant: string, listener: typeof emit) => { emit = listener; return vi.fn(); });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    emit("reminder", { notificationId: "n-other", userId: "user-other" });
    emit("reminder", { notificationId: "n-mine", userId: "user-me" });
    const received = await readUntil(reader, "event: task_reminder");
    expect(received).toContain('event: task_reminder\ndata: {"notificationId":"n-mine"}');
    expect(received).not.toContain("n-other");
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("answers an unauthenticated request with 401 JSON (which makes EventSource stop) and never subscribes", async () => {
    mocks.context.mockRejectedValue(new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await GET(new Request("http://localhost/api/dashboard/stream"));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("caps concurrent streams per user and frees the slot when a stream ends", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-cap" });
    mocks.subscribe.mockReturnValue(vi.fn());
    const aborts: AbortController[] = [];
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let index = 0; index < 6; index += 1) {
      const abort = new AbortController();
      aborts.push(abort);
      const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
      expect(response.status).toBe(200);
      readers.push(response.body!.getReader());
    }
    const refused = await GET(new Request("http://localhost/api/dashboard/stream"));
    expect(refused.status).toBe(429);
    aborts[0].abort();
    await readers[0].cancel().catch(() => {});
    const admitted = await GET(new Request("http://localhost/api/dashboard/stream"));
    expect(admitted.status).toBe(200);
    for (const [index, reader] of readers.entries()) { aborts[index].abort(); await reader.cancel().catch(() => {}); }
    await admitted.body!.cancel().catch(() => {});
  });

  it.each([
    { random: 0, retry: 1_000, lifetime: 250_000 },
    { random: 0.5, retry: 3_000, lifetime: 265_000 },
    { random: 0.9999999, retry: 5_000, lifetime: 280_000 },
  ])("gives each stream a lifetime of 250–280 s and a reconnect delay of 1–5 s at random (random $random)", async ({ random, retry, lifetime }) => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(random);
    try {
      const unsubscribe = vi.fn();
      mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: `user-random-${random}` });
      mocks.subscribe.mockReturnValue(unsubscribe);
      const response = await GET(new Request("http://localhost/api/dashboard/stream"));
      const reader = response.body!.getReader();
      expect(await readUntil(reader, "event: ready")).toMatch(new RegExp(`^retry: ${retry}\\n\\n`));
      vi.advanceTimersByTime(lifetime - 1);
      expect(unsubscribe).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      await reader.cancel().catch(() => {});
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("tells the browser to open the next stream 10 s before this one ends, and then ends it as before", async () => {
    vi.useFakeTimers({ now: 0 });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    // When each chunk was written, in fake milliseconds since the request.
    const written: { at: number; text: string }[] = [];
    const encode = TextEncoder.prototype.encode;
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, text?: string) {
      written.push({ at: Date.now(), text: text ?? "" });
      return encode.call(this, text);
    });
    try {
      const unsubscribe = vi.fn();
      mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-rollover" });
      mocks.subscribe.mockReturnValue(unsubscribe);
      const response = await GET(new Request("http://localhost/api/dashboard/stream"));
      const reader = response.body!.getReader();
      await readUntil(reader, "event: ready");
      // Lifetime 265 s (random 0.5): the hint goes out once, at 255 s.
      vi.advanceTimersByTime(264_999);
      expect(written.filter((chunk) => chunk.text.includes("rollover"))).toEqual([{ at: 255_000, text: "event: rollover\ndata: {}\n\n" }]);
      expect(unsubscribe).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      await reader.cancel().catch(() => {});
    } finally {
      encodeSpy.mockRestore();
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("sends no rollover hint from a stream that already ended", async () => {
    vi.useFakeTimers();
    try {
      mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-early-end" });
      mocks.subscribe.mockReturnValue(vi.fn());
      const abort = new AbortController();
      const response = await GET(new Request("http://localhost/api/dashboard/stream", { signal: abort.signal }));
      const reader = response.body!.getReader();
      await readUntil(reader, "event: ready");
      abort.abort();
      expect(vi.getTimerCount()).toBe(0);
      await reader.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });
});
