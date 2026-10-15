// The Grok launch catalog, read at register time from a short-lived
// `initialize` (issue #646). That the probe sends `initialize` and nothing
// else is pinned by grok-catalog.test.ts; that `initialize` creates no
// session and attempts no model request is a dated measurement of Grok
// 1.0.52 (docs/evidence/grok/2026-10-15-catalog-and-quota.md). Grok answers
// with a built-in list when it cannot fetch its own, and nothing in the
// answer marks it, so such a list is taken as it comes.

import type { EngineModelInfo } from "@kaoiro/protocol";
import { parseModelState } from "@kaoiro/grok";
import { GrokProbeError, runGrokProbe, type GrokProbeOptions } from "./grok_acp_probe.js";

export const GROK_DEFAULT_ENTRY: EngineModelInfo = { value: "default", display_name: "Account default" };

const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class GrokCatalogInvalid extends Error {
  constructor(readonly detail: string) {
    super(`grok model state is invalid: ${detail}`);
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The catalog of an `initialize` response: the `default` entry, then one
 *  entry per model. Throws GrokCatalogInvalid unless every model is well
 *  formed, so a reading is used whole or not at all. */
export function grokCatalogFromInitialize(initialized: unknown): EngineModelInfo[] {
  const meta = record(record(initialized)?._meta);
  const state = record(meta?.modelState);
  if (!state) throw new GrokCatalogInvalid("no modelState");
  const available = state.availableModels;
  if (!Array.isArray(available)) throw new GrokCatalogInvalid("no availableModels");
  const ids = new Set<string>();
  for (const entry of available) {
    const item = record(entry);
    const id = item?.modelId;
    if (typeof id !== "string" || !MODEL_ID.test(id) || id === GROK_DEFAULT_ENTRY.value)
      throw new GrokCatalogInvalid("bad modelId");
    if (ids.has(id)) throw new GrokCatalogInvalid("duplicate modelId");
    ids.add(id);
    if (!nonEmpty(item!.name)) throw new GrokCatalogInvalid("bad name");
    if (item!.description !== undefined && typeof item!.description !== "string")
      throw new GrokCatalogInvalid("bad description");
    const efforts = record(item!._meta)?.reasoningEfforts;
    if (efforts !== undefined && (!Array.isArray(efforts) || !efforts.every((e) => nonEmpty(record(e)?.value))))
      throw new GrokCatalogInvalid("bad reasoningEfforts");
  }
  if (typeof state.currentModelId !== "string" || !ids.has(state.currentModelId))
    throw new GrokCatalogInvalid("currentModelId not listed");
  return [
    GROK_DEFAULT_ENTRY,
    ...parseModelState(meta).map(({ window: _window, ...model }) => model),
  ];
}

export type GrokCatalogProbeOptions = Omit<GrokProbeOptions, "cwd"> & { cwd?: string };

/** Runs `initialize` alone against a fresh Grok and reads its catalog. */
export function probeGrokCatalog(options: GrokCatalogProbeOptions = {}): Promise<EngineModelInfo[]> {
  return runGrokProbe({ ...options, cwd: options.cwd ?? process.cwd() },
    async (_call, initialized) => grokCatalogFromInitialize(initialized));
}

/** The runner's Grok catalog: the last good reading kept in memory, else the
 *  `default` entry. One probe runs at a time; a newer refresh or abort()
 *  supersedes the one in flight, whose result is then dropped. */
export class GrokCatalog {
  #lastKnownGood: EngineModelInfo[] | undefined;
  #running: AbortController | undefined;

  constructor(
    private readonly probe: (options: GrokCatalogProbeOptions) => Promise<EngineModelInfo[]> = probeGrokCatalog,
    private readonly options: GrokCatalogProbeOptions = {},
    private readonly warn: (line: string) => void = (line) => process.stderr.write(line),
  ) {}

  current(): EngineModelInfo[] {
    return this.#lastKnownGood ?? [GROK_DEFAULT_ENTRY];
  }

  /** Resolves true when this probe changed the catalog the caller should
   *  publish, false when it failed, or was superseded or aborted: both of
   *  those clear `#running`, so its result is dropped quietly. */
  async refresh(): Promise<boolean> {
    this.abort();
    const running = new AbortController();
    this.#running = running;
    try {
      const catalog = await this.probe({ ...this.options, signal: running.signal });
      if (this.#running !== running) return false;
      this.#lastKnownGood = catalog;
      return true;
    } catch (error) {
      if (this.#running !== running) return false;
      const reason = error instanceof GrokCatalogInvalid ? error.detail
        : error instanceof GrokProbeError ? error.message : "unexpected failure";
      this.warn(`runner: grok catalog probe failed (${reason}); keeping the ${
        this.#lastKnownGood ? "last good catalog" : "default entry"}\n`);
      return false;
    } finally {
      if (this.#running === running) this.#running = undefined;
    }
  }

  /** Aborts the probe in flight, if any; its group is ended before its
   *  promise settles. */
  abort(): void {
    this.#running?.abort();
    this.#running = undefined;
  }
}
