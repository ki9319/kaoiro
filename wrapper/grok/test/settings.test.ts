import { expect, it, vi } from "vitest";
import { readTurnWatchdogSettings,
  resolveTurnWatchdogSettings } from "../src/settings.js";
it("retains the sources of effective watchdog settings", () => {
  const warn = vi.fn();
  const env = { KAOIRO_GROK_TURN_WATCHDOG_INACTIVITY_MS: "120000",
    KAOIRO_GROK_TURN_WATCHDOG_ABORT_GRACE_MS: "2000" };
  expect(resolveTurnWatchdogSettings(env, warn)).toEqual({
    settings: { inactivityMs: 120_000, abortGraceMs: 2_000 },
    sources: { inactivityMs: "env", abortGraceMs: "env" },
  });
  expect(warn).toHaveBeenCalledOnce();
  warn.mockClear();
  expect(resolveTurnWatchdogSettings(env, warn, {
    turn_watchdog_inactivity_ms: 1_800_000,
  })).toEqual({
    settings: { inactivityMs: 1_800_000, abortGraceMs: 2_000 },
    sources: { inactivityMs: "config", abortGraceMs: "env" },
  });
  expect(warn).not.toHaveBeenCalled();
  expect(resolveTurnWatchdogSettings({}, warn).sources)
    .toEqual({ inactivityMs: "default", abortGraceMs: "default" });
  expect(readTurnWatchdogSettings(env, warn).inactivityMs).toBe(120_000);
  expect(warn).toHaveBeenCalledOnce();
});
