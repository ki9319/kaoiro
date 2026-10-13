import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { childEnvironment, inspectPolicy } from "../src/grok/policy.js";
it.skipIf(process.env.KAOIRO_LIVE_GROK !== "1")(
  "native inspect includes a trusted project permission source",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-grok-project-"));
    const cwd = join(root, "work");
    const home = join(root, "grok-state");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    mkdirSync(home);
    execFileSync("git", ["init", "-q", cwd]);
    writeFileSync(join(cwd, "fixture.txt"), "fixture");
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Read(fixture.txt)"] } }),
    );
    writeFileSync(
      join(home, "config.toml"),
      "[features]\ntelemetry = false\n[telemetry]\ntrace_upload = false\n",
    );
    const env = childEnvironment(
      { ...process.env, GROK_HOME: home },
      "workspace",
    );
    try {
      const output = execFileSync(
        "grok",
        ["--no-auto-update", "--trust", "inspect", "--json"],
        { cwd, env, encoding: "utf8", timeout: 20_000 },
      );
      const raw = JSON.parse(output);
      const policy = await inspectPolicy("grok", cwd, env, "workspace");
      expect(raw.projectTrusted).toBe(true);
      expect(policy.inspect).toBe("ok");
      if (policy.inspect !== "ok") throw new Error("inspect unavailable");
      expect(policy.sources).toEqual(raw.permissions.sources);
      if (process.env.KAOIRO_LIVE_GROK_PROJECT_REPORT) {
        writeFileSync(
          process.env.KAOIRO_LIVE_GROK_PROJECT_REPORT,
          JSON.stringify(
            {
              sources: policy.sources,
              loaded: raw.permissions.loaded,
              projectTrusted: raw.projectTrusted,
              projectRoot: raw.projectRoot,
            },
            null,
            2,
          ),
        );
      }
      expect(
        policy.sources.some((source) =>
          source.startsWith(join(cwd, ".claude/settings.json")),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
