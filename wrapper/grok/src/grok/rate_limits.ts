export interface GrokRateLimits {
  seven_day: {
    utilization: number;
    resets_at: number;
  };
}

export type GrokRateLimitRead =
  | { kind: "reading"; value: GrokRateLimits }
  | { kind: "invalid_shape" | "unsupported" | "timeout" | "auth_failed" | "transport_error" | "skipped" | "retired" };

interface ReaderOptions {
  request: (cancellationSignal: AbortSignal) => Promise<unknown>;
  diagnostic?: (line: string) => void;
  now?: () => number;
  deadlineMs?: number;
  successIntervalMs?: number;
  retryFloorMs?: number;
}

interface RequestSlot {
  id: symbol;
  cancellation: AbortController;
  timedOut: boolean;
  timer?: ReturnType<typeof setTimeout>;
  result: Promise<GrokRateLimitRead>;
  resolve: (result: GrokRateLimitRead) => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseRfc3339(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?([Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return undefined;
  const milliseconds = Date.parse(value.replace(/[tz]/g, (letter) => letter.toUpperCase()));
  if (!Number.isFinite(milliseconds)) return undefined;
  const seconds = Math.floor(milliseconds / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Project only the measured weekly allowance fields; vendor billing details stay private. */
export function parseGrokBilling(value: unknown): GrokRateLimits | undefined {
  const config = record(record(value)?.config);
  const period = record(config?.currentPeriod);
  const percent = config?.creditUsagePercent;
  if (!config || !period || period.type !== "USAGE_PERIOD_TYPE_WEEKLY" ||
      typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)
    return undefined;
  const reset = parseRfc3339(period.end);
  if (reset === undefined) return undefined;
  if (period.start !== undefined) {
    const start = parseRfc3339(period.start);
    if (start === undefined || start >= reset) return undefined;
  }
  return { seven_day: { utilization: percent / 100, resets_at: reset } };
}

function structuredAuthFailure(error: unknown): boolean {
  const top = errorRecord(error);
  const data = record(top?.data);
  const nested = record(data?.error);
  for (const candidate of [top, data, nested]) {
    if (!candidate) continue;
    for (const key of ["status", "statusCode", "httpStatus"])
      if (candidate[key] === 401) return true;
    const code = candidate.code;
    if (code === 401) return true;
    if (typeof code === "string" && new Set([
      "401", "AUTH_FAILED", "AUTHENTICATION_FAILED", "UNAUTHORIZED", "UNAUTHENTICATED", "INVALID_API_KEY",
    ]).has(code.toUpperCase())) return true;
  }
  return false;
}

function errorCode(error: unknown): unknown {
  return errorRecord(error)?.code;
}

export class GrokRateLimitReader {
  #slot: RequestSlot | undefined;
  #lastSuccessAt: number | undefined;
  #lastFailureSettledAt: number | undefined;
  #unsupported = false;
  #retired = false;
  readonly #logged = new Set<string>();
  readonly #now: () => number;
  readonly #deadlineMs: number;
  readonly #successIntervalMs: number;
  readonly #retryFloorMs: number;

  constructor(private readonly options: ReaderOptions) {
    this.#now = options.now ?? Date.now;
    this.#deadlineMs = options.deadlineMs ?? 20_000;
    this.#successIntervalMs = options.successIntervalMs ?? 60_000;
    this.#retryFloorMs = options.retryFloorMs ?? 5 * 60_000;
  }

  read(): Promise<GrokRateLimitRead> {
    if (this.#retired) return Promise.resolve({ kind: "retired" });
    if (this.#unsupported) return Promise.resolve({ kind: "unsupported" });
    if (this.#slot) return this.#slot.result;
    const now = this.#now();
    if (this.#lastSuccessAt !== undefined && now - this.#lastSuccessAt < this.#successIntervalMs)
      return Promise.resolve({ kind: "skipped" });
    if (this.#lastFailureSettledAt !== undefined && now - this.#lastFailureSettledAt < this.#retryFloorMs)
      return Promise.resolve({ kind: "skipped" });

    let resolve!: (result: GrokRateLimitRead) => void;
    const result = new Promise<GrokRateLimitRead>((done) => { resolve = done; });
    const slot: RequestSlot = { id: Symbol(), cancellation: new AbortController(), timedOut: false,
      result, resolve };
    this.#slot = slot;
    slot.timer = setTimeout(() => {
      if (this.#slot !== slot || this.#retired) return;
      slot.timedOut = true;
      this.#report("timeout", " outstanding=true");
      slot.cancellation.abort();
      slot.resolve({ kind: "timeout" });
    }, this.#deadlineMs);

    void Promise.resolve().then(() => this.options.request(slot.cancellation.signal)).then(
      (response) => this.#settle(slot, { kind: "response", response }),
      (error: unknown) => this.#settle(slot, { kind: "error", error }),
    );
    return result;
  }

  retire() {
    if (this.#retired) return;
    this.#retired = true;
    const slot = this.#slot;
    this.#slot = undefined;
    if (slot) {
      clearTimeout(slot.timer);
      slot.cancellation.abort();
      slot.resolve({ kind: "retired" });
    }
  }

  #settle(slot: RequestSlot, response: { kind: "response"; response: unknown } | { kind: "error"; error: unknown }) {
    if (this.#slot !== slot) return;
    if (this.#retired) {
      this.#slot = undefined;
      return;
    }
    if (slot.timedOut) {
      this.#lastFailureSettledAt = this.#now();
      this.#slot = undefined;
      return;
    }
    clearTimeout(slot.timer);
    let outcome: GrokRateLimitRead;
    if (response.kind === "response") {
      const value = parseGrokBilling(response.response);
      if (value) {
        this.#lastSuccessAt = this.#now();
        this.#report("ok");
        outcome = { kind: "reading", value };
      } else {
        this.#lastFailureSettledAt = this.#now();
        this.#report("invalid_shape");
        outcome = { kind: "invalid_shape" };
      }
    } else if (errorCode(response.error) === -32601) {
      this.#unsupported = true;
      this.#report("unsupported");
      outcome = { kind: "unsupported" };
    } else if (structuredAuthFailure(response.error)) {
      this.#lastFailureSettledAt = this.#now();
      this.#report("auth_failed");
      outcome = { kind: "auth_failed" };
    } else {
      this.#lastFailureSettledAt = this.#now();
      this.#report("transport_error");
      outcome = { kind: "transport_error" };
    }
    this.#slot = undefined;
    slot.resolve(outcome);
  }

  #report(outcome: string, suffix = "") {
    if (this.#logged.has(outcome)) return;
    this.#logged.add(outcome);
    try { this.options.diagnostic?.(`grok: billing=${outcome}${suffix}`); } catch { /* Diagnostics must not affect host readiness. */ }
  }
}
