import { resolveDigitsMs } from "@kaoiro/wrapper-core";

export interface WatchdogSettings {
  inactivityMs: number;
  abortGraceMs: number;
}
export function readTurnWatchdogSettings(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  config?: {
    turn_watchdog_inactivity_ms?: number;
    turn_watchdog_abort_grace_ms?: number;
  },
): WatchdogSettings {
  void warn;
  return {
    inactivityMs: resolveDigitsMs(
      env,
      "KAOIRO_GROK_TURN_WATCHDOG_INACTIVITY_MS",
      config?.turn_watchdog_inactivity_ms,
      30 * 60_000,
      60_000,
      2_147_483_647,
    ).value,
    abortGraceMs: resolveDigitsMs(
      env,
      "KAOIRO_GROK_TURN_WATCHDOG_ABORT_GRACE_MS",
      config?.turn_watchdog_abort_grace_ms,
      3_000,
      1,
      2_147_483_647,
    ).value,
  };
}
