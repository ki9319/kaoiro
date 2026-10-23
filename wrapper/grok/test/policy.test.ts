import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  childEnvironment,
  inspectPolicy,
  parsePermissionPolicy,
  sandboxProfile,
} from "../src/grok/policy.js";
const common = {
  grok_sandbox_env: "workspace" as const,
  grok_version: "fixture",
};
const observed = () => ({
  permissions: {
    sources: ["user", "project"],
    loaded: 2,
    skipped: [{ rule: "fixture", reason: "unknown" }],
    managedSettingsActive: false,
  },
  externalCompat: {
    cells: [
      { vendor: "claude", surface: "hooks", enabled: true, source: "config" },
    ],
  },
});
describe("permission sources", () => {
  it("copies observed fields and permits a false hooks cell", () => {
    const raw = observed();
    raw.externalCompat.cells[0]!.enabled = false;
    expect(parsePermissionPolicy(raw, common)).toEqual({
      ...common,
      inspect: "ok",
      sources: ["user", "project"],
      rules_loaded: 2,
      rules_skipped: 1,
      managed_settings_active: false,
      claude_hooks: { enabled: false, source: "config" },
    });
  });
  it.each(["missing", "duplicate", "mistyped", "bad-permissions", "failed"])(
    "keeps inspect fields unknown for %s",
    (mode) => {
      const raw = observed();
      if (mode === "missing") raw.externalCompat.cells = [];
      if (mode === "duplicate")
        raw.externalCompat.cells.push(raw.externalCompat.cells[0]!);
      if (mode === "mistyped")
        (raw.externalCompat.cells[0] as Record<string, unknown>).enabled =
          "true";
      if (mode === "bad-permissions")
        (raw.permissions as Record<string, unknown>).loaded = "2";
      expect(
        parsePermissionPolicy(mode === "failed" ? null : raw, common),
      ).toEqual({ ...common, inspect: "unavailable" });
    },
  );
  it("strips compat overrides and preserves HOME", () => {
    const env = childEnvironment(
      {
        HOME: "/fixture/home",
        GROK_CLAUDE_HOOKS_ENABLED: "false",
        GROK_CLAUDE_SKILLS_ENABLED: "false",
        GROK_CLAUDE_RULES_ENABLED: "false",
        GROK_CLAUDE_AGENTS_ENABLED: "false",
        GROK_CLAUDE_MCPS_ENABLED: "false",
        GROK_CONFIG: "{}",
      },
      "workspace",
    );
    expect(env).toEqual({
      HOME: "/fixture/home",
      GROK_CONFIG: "{}",
      GROK_SANDBOX: "workspace",
      KAOIRO_AGENT: "1",
    });
  });
  it.each([undefined, "", "1", "legacy"])("marks a copied native environment with parent marker %s", marker => {
    const inherited = { HOME: "/fixture/home", ...(marker === undefined ? {} : { KAOIRO_AGENT: marker }) };
    expect(childEnvironment(inherited, "off")).toEqual({ HOME: "/fixture/home", GROK_SANDBOX: "off", KAOIRO_AGENT: "1" });
    expect(inherited.KAOIRO_AGENT).toBe(marker);
  });
  it.each(["FAIL", "UNKNOWN", "HANG"])(
    "marks a real inspect process unavailable for %s",
    async (mode) => {
      const policy = await inspectPolicy(
        fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
        process.cwd(),
        { ...process.env, [`KAOIRO_TEST_GROK_INSPECT_${mode}`]: "1" },
        "workspace",
      );
      expect(policy).toEqual({
        grok_version: "grok fixture 1.0.52",
        grok_sandbox_env: "workspace",
        inspect: "unavailable",
      });
    },
  );
});
describe("supported permission pairs", () => {
  const cwd = process.cwd();
  it("accepts the declared platform/profile pairs", () => {
    expect(
      sandboxProfile(
        { sandbox: "workspace-write", network_access: true },
        cwd,
        {},
        "linux",
      ),
    ).toBe("workspace");
    expect(
      sandboxProfile(
        { sandbox: "read-only", network_access: false },
        "/usr",
        {},
        "linux",
      ),
    ).toBe("read-only");
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(
        sandboxProfile(
          { sandbox: "danger-full-access", network_access: true },
          cwd,
          {},
          platform,
        ),
      ).toBe("off");
    }
  });
  it.each(["darwin", "win32"] as const)(
    "rejects OS sandbox pairs on %s",
    (platform) => {
      for (const pair of [
        { sandbox: "read-only" as const, network_access: false },
        { sandbox: "workspace-write" as const, network_access: true },
      ]) {
        expect(() => sandboxProfile(pair, cwd, {}, platform)).toThrow(
          "require Linux",
        );
      }
    },
  );
  it("normalizes full-access and read-only network toggles but rejects workspace offline", () => {
    expect(sandboxProfile({ sandbox: "danger-full-access", network_access: false }, cwd, {}, "linux")).toBe("off");
    expect(sandboxProfile({ sandbox: "read-only", network_access: true }, "/usr", {}, "linux")).toBe("read-only");
    expect(() => sandboxProfile({ sandbox: "workspace-write", network_access: false }, cwd, {}, "linux")).toThrow("unsupported");
  });
  it("rejects always-writable directories including symlink aliases", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kaoiro-grok-policy-"));
    try {
      symlinkSync("/tmp", join(scratch, "alias"));
      mkdirSync(join(scratch, "..child"));
      expect(() =>
        sandboxProfile(
          { sandbox: "read-only", network_access: false },
          join(scratch, "..child"),
          { GROK_HOME: scratch },
          "linux",
        ),
      ).toThrow("always-writable");
      expect(() =>
        sandboxProfile(
          { sandbox: "read-only", network_access: false },
          join(scratch, "alias"),
          {},
          "linux",
        ),
      ).toThrow("always-writable");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
