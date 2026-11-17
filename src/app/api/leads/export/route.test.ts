// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), query: vi.fn(), cursor: vi.fn(), timezone: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-query-service", () => ({ queryLeads: mocks.query, getLeadsCursor: mocks.cursor, resolveTenantTimezone: mocks.timezone }));

import { POST } from "./route";

/** The newest lead when the download began: every read is limited to leads saved up to it. */
const CURSOR = "2026-11-13T09:00:00.123456+00:00";
const FIRST_PAGE = { offset: 0, limit: 1000, savedBefore: CURSOR };
/** The query service answers with these rows once; the next read is empty, which ends the download. */
function onePage(page: { timezone: string; total: number; items: unknown[] }) {
  mocks.query.mockReset();
  mocks.query.mockResolvedValueOnce(page).mockResolvedValue({ ...page, items: [] });
  mocks.cursor.mockResolvedValue(CURSOR);
}

describe("authenticated lead CSV route", () => {
  it("passes tenant and every filter to export mode and returns all filtered rows", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    onePage({
      timezone: "Asia/Kolkata",
      total: 2,
      items: [
        { leadgenId: "lg-1", leadName: "First", email: "first@example.com", phone: "111", facebookPage: "Page A", adName: "Ad A", adId: "ad-a", status: "New Lead", label: "Warm", leadDate: "2026-09-09T02:00:00Z" },
        { leadgenId: "lg-2", leadName: "Second", email: "second@example.com", phone: "222", facebookPage: "Page A", adName: "Ad B", adId: "ad-b", status: "Contacted", label: "Hot", leadDate: "2026-09-09T03:00:00Z" },
      ],
    });
    const filters = { pageRecordId: "00000000-0000-4000-8000-000000000001", adId: "ad-a", dateFrom: "2026-09-01", dateTo: "2026-09-10", search: "First" };
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify(filters), headers: { "content-type": "application/json" } }));
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, expect.objectContaining(filters), FIRST_PAGE);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Lead ID,Lead Name,Lead Date,Status,Label,Email,Phone,Facebook Page,Ad Name,Ad ID,Assigned To");
    // The date sits right after the name in every row too, formatted on the company clock.
    const firstDate = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-09-09T02:00:00Z"));
    expect(lines[1]).toBe(`lg-1,First,"${firstDate}",New Lead,Warm,first@example.com,111,Page A,Ad A,ad-a,`);
    expect(csv).toContain("First");
    expect(csv).toContain("Second");
    expect(csv).not.toContain("Project");
    expect(csv).not.toMatch(/token|secret|authorization/i);
  });

  /**
   * The bodies below are what the Download button actually posts — unfiltered, one filter, and
   * several combined. The schema is strict, so any field the client sends that this route does not
   * declare fails the whole export with a 400 before a single row is read. That is worth a test of
   * its own: the client and this schema have to keep agreeing, and only an exact body proves it.
   */
  it("accepts every filter combination the Download button sends and exports each in full", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    onePage({ timezone: "Asia/Kolkata", total: 0, items: [] });
    const bodies = [
      { quickFilter: "all" },
      { quickFilter: "today" },
      { quickFilter: "all", adId: "6301-karuvi" },
      { quickFilter: "all", status: "New Lead", label: "Hot", search: "Kumar" },
      { quickFilter: "all", status: "New Lead", dateFrom: "2026-09-01", dateTo: "2026-09-10", pageRecordId: "00000000-0000-4000-8000-000000000001", adId: "6301-karuvi" },
      // Everything at once: search, Page, Ad, Status, Label and both date bounds.
      { quickFilter: "all", search: "Kumar", pageRecordId: "00000000-0000-4000-8000-000000000001", adId: "6301-karuvi", status: "New Lead", label: "Hot", dateFrom: "2026-09-01", dateTo: "2026-09-10" },
      // Google Ads with a campaign (or Unattributed): the download follows the Campaign filter.
      { quickFilter: "all", source: "google_ads", campaignId: "22334455" },
      { quickFilter: "all", source: "google_ads", campaignId: "unattributed", status: "New Lead", search: "Kumar" },
    ];

    for (const body of bodies) {
      const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      // Every filter reaches the query service unchanged, in export mode (no pagination).
      expect(mocks.query).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, body, FIRST_PAGE);
    }
  });

  it("accepts the Source filter and writes empty Lead ID, Page and Ad cells for a call-in lead", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    onePage({
      timezone: "Asia/Kolkata", total: 1,
      items: [{ leadgenId: "", leadName: "Caller", email: null, phone: "9876543210", facebookPage: "-", adName: "-", adId: null, source: "telecaller", status: "New Lead", label: "Warm", leadDate: "2026-10-26T05:00:00Z", assigneeName: "Ravi" }],
    });
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "telecaller" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(200);
    const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-10-26T05:00:00Z"));
    expect((await response.text()).replace(/^﻿/, "").split("\r\n")[1]).toBe(`,Caller,"${date}",New Lead,Warm,,9876543210,,,,Ravi`);
  });

  it.each([
    ["a non-numeric campaign id", "abc"],
    ["a campaign id that would add a PostgREST filter", "1,lead_name.eq.x"],
    ["an empty campaign id", ""],
  ])("rejects %s with a 400 before reading any lead", async (_name, campaignId) => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.query.mockClear();
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "google_ads", campaignId }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("authenticated lead CSV route, webhook leads", () => {
  it("accepts the Webhook source and writes the tool's lead_id, Webhook and the source it named", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    onePage({
      timezone: "Asia/Kolkata", total: 1,
      items: [{ leadgenId: "lp-42", leadName: "John Doe", email: "john@example.com", phone: "9876543210", facebookPage: "Webhook", adName: "Landing Page", adId: null, source: "custom_webhook", status: "New Lead", label: "Warm", leadDate: "2026-11-11T05:00:00Z", assigneeName: null }],
    });
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "custom_webhook" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, { quickFilter: "all", source: "custom_webhook" }, FIRST_PAGE);
    const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-11-11T05:00:00Z"));
    expect((await response.text()).replace(/^﻿/, "").split("\r\n")[1]).toBe(`lp-42,John Doe,"${date}",New Lead,Warm,john@example.com,9876543210,Webhook,Landing Page,,`);
  });

  it("leaves the Ad Name cell empty for a webhook lead sent without a source (never '-)", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    onePage({
      timezone: "Asia/Kolkata", total: 1,
      items: [{ leadgenId: "", leadName: "Asha", email: "asha@example.com", phone: null, facebookPage: "Webhook", adName: "-", adId: null, source: "custom_webhook", status: "New Lead", label: "Warm", leadDate: "2026-11-11T05:00:00Z", assigneeName: null }],
    });
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "custom_webhook" }), headers: { "content-type": "application/json" } }));
    const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-11-11T05:00:00Z"));
    expect((await response.text()).replace(/^﻿/, "").split("\r\n")[1]).toBe(`,Asha,"${date}",New Lead,Warm,asha@example.com,,Webhook,,,`);
  });
});

describe("authenticated lead CSV route, 99acres leads", () => {
  it("accepts the 99acres source and writes 99acres's lead id, 99acres and the project; no project leaves Ad Name empty", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    onePage({
      timezone: "Asia/Kolkata", total: 2,
      items: [
        { leadgenId: "ENQ-1", leadName: "Ravi", email: null, phone: "9876543210", facebookPage: "99acres", adName: "Green Valley", adId: null, source: "99acres", status: "New Lead", label: "Warm", leadDate: "2026-11-17T05:00:00Z", assigneeName: null },
        { leadgenId: "", leadName: "99acres Lead", email: null, phone: "9123456789", facebookPage: "99acres", adName: "-", adId: null, source: "99acres", status: "New Lead", label: "Warm", leadDate: "2026-11-17T05:00:00Z", assigneeName: null },
      ],
    });
    const response = await POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all", source: "99acres" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(200);
    const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-11-17T05:00:00Z"));
    const lines = (await response.text()).replace(/^﻿/, "").split("\r\n");
    expect(lines[1]).toBe(`ENQ-1,Ravi,"${date}",New Lead,Warm,,9876543210,99acres,Green Valley,,`);
    expect(lines[2]).toBe(`,99acres Lead,"${date}",New Lead,Warm,,9123456789,99acres,,,`);
  });
});

describe("large downloads", () => {
  const row = (index: number) => ({ leadgenId: `lg-${index}`, leadName: `Lead ${index}`, email: null, phone: null, facebookPage: "Page A", adName: "Ad A", adId: "ad-a", source: "facebook", status: "New Lead", label: "Warm", leadDate: "2026-11-11T05:00:00Z", assigneeName: null });
  const rows = (from: number, count: number) => Array.from({ length: count }, (_, offset) => row(from + offset));
  const page = (items: unknown[]) => ({ timezone: "Asia/Kolkata", total: items.length, page: 1, pageSize: items.length, totalPages: 1, items });
  const exportAll = () => POST(new Request("http://localhost/api/leads/export", { method: "POST", body: JSON.stringify({ quickFilter: "all" }), headers: { "content-type": "application/json" } }));
  const dataLines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n").slice(1);

  it("reads page after page until one is empty, so more leads than one read returns all reach the file", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.cursor.mockResolvedValue(CURSOR);
    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce(page(rows(0, 1000))).mockResolvedValueOnce(page(rows(1000, 1))).mockResolvedValue(page([]));
    const lines = dataLines(await (await exportAll()).text());
    expect(lines).toHaveLength(1001);
    expect(lines[1000]).toContain("lg-1000,Lead 1000");
    expect(mocks.query.mock.calls.map((call) => call[2])).toEqual([0, 1000, 1001].map((offset) => ({ offset, limit: 1000, savedBefore: CURSOR })));
  });

  it("does not stop early when the API's row cap is lower than one read", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.cursor.mockResolvedValue(CURSOR);
    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce(page(rows(0, 500))).mockResolvedValueOnce(page(rows(500, 500))).mockResolvedValue(page([]));
    expect(dataLines(await (await exportAll()).text())).toHaveLength(1000);
    expect(mocks.query.mock.calls.map((call) => (call[2] as { offset: number }).offset)).toEqual([0, 500, 1000]);
  });

  it("writes only the header for a company with no leads, after the same company-clock check", async () => {
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.cursor.mockResolvedValue(null);
    mocks.timezone.mockResolvedValue("Asia/Kolkata");
    mocks.query.mockReset();
    const response = await exportAll();
    expect(response.status).toBe(200);
    expect((await response.text()).replace(/^﻿/, "")).toBe("Lead ID,Lead Name,Lead Date,Status,Label,Email,Phone,Facebook Page,Ad Name,Ad ID,Assigned To");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("answers with the usual error when the first read fails, before any of the file is sent", async () => {
    const { AppError } = await import("@/lib/server/app-error");
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.cursor.mockResolvedValue(CURSOR);
    mocks.query.mockReset();
    mocks.query.mockRejectedValue(new AppError("Leads could not be loaded.", { status: 500, code: "LEAD_QUERY_FAILED" }));
    const response = await exportAll();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "LEAD_QUERY_FAILED" } });
  });

  it("ends the download with an error when a later read fails, so a cut-off file is never saved as complete", async () => {
    const { AppError } = await import("@/lib/server/app-error");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.context.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
    mocks.cursor.mockResolvedValue(CURSOR);
    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce(page(rows(0, 1000))).mockRejectedValue(new AppError("Leads could not be loaded.", { status: 500, code: "LEAD_QUERY_FAILED" }));
    const response = await exportAll();
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });
});
