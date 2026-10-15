import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokRateLimitReader, parseGrokBilling } from "../src/grok/rate_limits.js";

const weekly = (percent: unknown = 12.5, end: unknown = "2099-12-31T12:00:00.900Z",
  start: unknown = "2099-12-24T12:00:00Z") => ({
  config: { creditUsagePercent: percent, currentPeriod: {
    type: "USAGE_PERIOD_TYPE_WEEKLY", start, end,
  }, billingPeriodEnd: "private", subscription: { amount: 123 } },
});

afterEach(() => vi.useRealTimers());

describe("parseGrokBilling", () => {
  it.each([
    { percent: 0, end: "2099-12-31T12:00:00Z", expected: 0 },
    { percent: 12.5, end: "2099-12-31T12:00:00.900Z", expected: 0.125 },
    { percent: 100, end: "2099-12-31T12:00:00+05:30", expected: 1 },
    { percent: 50, end: "2099-12-31T12:00:00-04:00", expected: 0.5 },
  ])("normalizes weekly utilization and seconds", ({ percent, end, expected }) => {
    const parsed = parseGrokBilling(weekly(percent, end));
    expect(parsed).toEqual({ seven_day: {
      utilization: expected, resets_at: Math.floor(Date.parse(String(end)) / 1000),
    } });
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(JSON.stringify(parsed)).not.toContain("amount");
  });

  it.each([
    ["null", null],
    ["missing config", {}],
    ["null config", { config: null }],
    ["missing period", { config: { creditUsagePercent: 10 } }],
    ["monthly period", {
      config: { creditUsagePercent: 10, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2099-12-31T00:00:00Z" } },
    }],
    ["legacy response", { config: { creditUsagePercent: 10, billingPeriodEnd: "2099-12-31T00:00:00Z" } }],
    ["string percentage", weekly("12.5")],
    ["NaN percentage", weekly(Number.NaN)],
    ["infinite percentage", weekly(Number.POSITIVE_INFINITY)],
    ["negative percentage", weekly(-0.01)],
    ["over 100 percentage", weekly(100.01)],
    ["invalid calendar date", weekly(10, "2099-02-29T00:00:00Z")],
    ["missing timezone", weekly(10, "2099-12-31T00:00:00")],
    ["millisecond number", weekly(10, 4_102_444_800_000)],
    ["invalid start", weekly(10, "2099-12-31T00:00:00Z", "2099-02-29T00:00:00Z")],
    ["reversed period", weekly(10, "2099-12-24T00:00:00Z", "2099-12-31T00:00:00Z")],
  ])("rejects %s", (_label, raw) => {
    expect(parseGrokBilling(raw)).toBeUndefined();
  });

  it("accepts an expired but valid weekly timestamp", () => {
    const parsed = parseGrokBilling(weekly(40, "2020-01-01T00:00:00Z", "2019-12-25T00:00:00Z"));
    expect(parsed?.seven_day.resets_at).toBe(1_577_836_800);
  });
});

describe("GrokRateLimitReader", () => {
  it("enforces the success minimum interval", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(weekly());
    const reader = new GrokRateLimitReader({ request });
    await expect(reader.read()).resolves.toMatchObject({ kind: "reading" });
    await expect(reader.read()).resolves.toEqual({ kind: "skipped" });
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(reader.read()).resolves.toMatchObject({ kind: "reading" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("coalesces physical requests and retains the slot after a timeout", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const request = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise<unknown>((resolve) => { finish = resolve; });
    });
    const diagnostics: string[] = [];
    const reader = new GrokRateLimitReader({ request, deadlineMs: 20,
      retryFloorMs: 300, diagnostic: (line) => diagnostics.push(line) });
    const first = reader.read();
    const coalesced = reader.read();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toEqual({ kind: "timeout" });
    await expect(coalesced).resolves.toEqual({ kind: "timeout" });
    expect(signal?.aborted).toBe(true);
    await expect(reader.read()).resolves.toEqual({ kind: "timeout" });
    expect(request).toHaveBeenCalledTimes(1);
    finish!(weekly());
    await Promise.resolve();
    await Promise.resolve();
    await expect(reader.read()).resolves.toEqual({ kind: "skipped" });
    await vi.advanceTimersByTimeAsync(300);
    request.mockResolvedValueOnce(weekly());
    await expect(reader.read()).resolves.toMatchObject({ kind: "reading" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual(["grok: billing=timeout outstanding=true", "grok: billing=ok"]);
  });

  it("uses only structured auth fields and disables unknown methods", async () => {
    const diagnostics: string[] = [];
    const auth = Object.assign(new Error("DO_NOT_LOG_401"), {
      code: -32000, data: { status: 401 },
    });
    const request = vi.fn().mockRejectedValueOnce(auth).mockRejectedValueOnce(new Error("401 in text"));
    const reader = new GrokRateLimitReader({ request, diagnostic: (line) => diagnostics.push(line) });
    await expect(reader.read()).resolves.toEqual({ kind: "auth_failed" });
    await expect(reader.read()).resolves.toEqual({ kind: "skipped" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(["grok: billing=auth_failed"]);
    expect(diagnostics.join(" ")).not.toContain("DO_NOT_LOG");

    const unsupported = new GrokRateLimitReader({
      request: vi.fn().mockRejectedValue(Object.assign(new Error("private"), { code: -32601 })),
      diagnostic: (line) => diagnostics.push(line),
    });
    await expect(unsupported.read()).resolves.toEqual({ kind: "unsupported" });
    await expect(unsupported.read()).resolves.toEqual({ kind: "unsupported" });
    expect(diagnostics.at(-1)).toBe("grok: billing=unsupported");

    const messageOnly = new GrokRateLimitReader({
      request: vi.fn().mockRejectedValue(new Error("401 in message only")),
    });
    await expect(messageOnly.read()).resolves.toEqual({ kind: "transport_error" });
  });

  it("retirement releases the result and ignores a late response", async () => {
    let finish!: (value: unknown) => void;
    const reader = new GrokRateLimitReader({ request: () => new Promise((resolve) => { finish = resolve; }) });
    const attempt = reader.read();
    await Promise.resolve();
    reader.retire();
    await expect(attempt).resolves.toEqual({ kind: "retired" });
    finish!(weekly());
    await Promise.resolve();
    await expect(reader.read()).resolves.toEqual({ kind: "retired" });
  });
});
