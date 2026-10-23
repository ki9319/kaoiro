export const TIERS: readonly string[];
export const CANARY: string;
export const REPORTER: string;

export interface TierLists {
  integration: string[];
  native: string[];
}

export interface TierSelection {
  include: string[];
  exclude?: string[];
  reporters?: string[];
}

export interface TierRecord {
  tier: string;
  commit: string | null;
  runId: string | null;
  attempt: number | null;
  files: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  outcome: "pass" | "fail";
  wallMs: number;
  counted: boolean;
  notice: string;
}

export interface TierRunFile {
  tasks?: unknown[];
  result?: { state?: string };
}

export function loadTiers(runnerDir: string): TierLists;
export function selectTier(tier: string, runnerDir: string, defaultExclude: readonly string[]): TierSelection;
export function compareSelections(input: {
  complete: Iterable<string>;
  fast: Iterable<string>;
  integration: Iterable<string>;
  native: Iterable<string>;
  declared: TierLists;
}): string[];
export function countCompleteFiles(runnerDir: string): number;
export function buildRecord(input: {
  tier: string;
  files: TierRunFile[];
  errors: unknown[];
  total: number;
  wallMs: number;
  commit: string | null;
  env: Record<string, string | undefined>;
}): TierRecord;

export default class TierReporter {
  onInit(context: { config: { root: string } }): void;
  onFinished(files?: TierRunFile[], errors?: unknown[]): void;
}
