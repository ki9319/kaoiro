import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSnapshotExt, WrapperConfig } from "@kaoiro/agent-common";
import type { GrokHost } from "../src/host.js";
import { nativeRun, removeGrokState } from "./native-support.js";

// Work unit 3a acceptance against the real grok (issue #644): a resumed agent
// keeps its cwd, engine, permission, and model and effort with their sources,
// across two resumes with no drift. Runs only with KAOIRO_LIVE_GROK=1.

const live = process.env.KAOIRO_LIVE_GROK === "1";
type Sandbox = NonNullable<WrapperConfig["sandbox"]>;
const config = (sandbox: Sandbox, extra: Partial<WrapperConfig> = {}): WrapperConfig => ({
  agent_id: "native.resume", display_name: "Resume fixture", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox, network_access: sandbox !== "read-only", ...extra,
});
const ext = (host: GrokHost) => host.statusExtSnapshot() as Record<string, any>;
const ready = (host: GrokHost) =>
  vi.waitFor(() => {
    expect(host.state).toBe("waiting_input");
    expect(ext(host)).not.toHaveProperty("pending_model");
    expect(ext(host)).not.toHaveProperty("pending_effort");
  }, { timeout: 60_000 });
/** The relaunch config the runner builds from a stored snapshot (explicit
 *  sources kept, see runner applyResumeSnapshot). */
const relaunch = (stored: ResolvedSnapshotExt, sandbox: Sandbox): Partial<WrapperConfig> => ({
  ...(stored.model_source && stored.model_source !== "default"
    ? { model: stored.model!, model_source: stored.model_source } : {}),
  ...(stored.effort_source && stored.effort_source !== "default"
    ? { effort: stored.effort!, effort_source: stored.effort_source } : {}),
  resume_snapshot: { ...stored, sandbox },
});

describe.skipIf(!live)("native cold resume", () => {
  it("keeps cwd, engine, permission, model and sources across two resumes, and applies a differing pick", async () => {
    // Each cwd is its own mkdtemp directory, so removeGrokState can match
    // Grok's workspace for it exactly.
    const cwd = mkdtempSync(join(homedir(), ".kaoiro-grok-resume-"));
    const other = mkdtempSync(join(homedir(), ".kaoiro-grok-resume-"));
    try {
      let sessionId: string | undefined;
      let stored: ResolvedSnapshotExt = {};
      let catalog: string[] = [];
      await nativeRun(config("workspace-write"), cwd, async (host) => {
        await ready(host);
        catalog = (ext(host).models as { value: string }[]).map((m) => m.value);
        const target = catalog.find((m) => m !== ext(host).model)!;
        await host.setModel(target);
        await vi.waitFor(() => expect(ext(host).model).toBe(target), { timeout: 30_000 });
        await host.send("Reply with the single word OK.");
        stored = ext(host).effective;
        expect(stored).toMatchObject({ model: target, model_source: "config",
          sandbox: "workspace-write", network_access: true });
      }, undefined, undefined, undefined, { onSessionId: (id) => { sessionId = id; } });
      expect(sessionId).toBeDefined();

      // Resume 1 and resume 2, each built from the previous run's effective.
      for (let round = 1; round <= 2; round += 1) {
        let resumedId: string | undefined;
        const before = stored;
        await nativeRun(config("workspace-write", relaunch(before, "workspace-write")), cwd, async (host) => {
          await ready(host);
          const now = ext(host);
          expect(now).toMatchObject({ engine: "grok", cwd, model: before.model, model_source: before.model_source,
            effort: before.effort, permission: { sandbox: "workspace-write" } });
          expect(now.effective).toMatchObject(before);
          expect(now.resume_drift).toEqual([]);
          expect(host.statusSnapshot()).toMatchObject({ engine: "grok", model: before.model,
            model_source: before.model_source, network_access: true });
          await host.send("Reply with the single word OK.");
          expect(host.state).toBe("waiting_input");
          stored = ext(host).effective;
        }, undefined, undefined, undefined, { argv: ["--resume", sessionId!], onSessionId: (id) => { resumedId = id; } });
        expect(resumedId).toBe(sessionId);
      }

      // A stored pick that differs from the session's model is applied
      // before the first prompt, with its relayed source.
      const pick = catalog.find((m) => m !== stored.model)!;
      await nativeRun(config("workspace-write", { model: pick, model_source: "launch" }), cwd, async (host) => {
        await ready(host);
        expect(ext(host)).toMatchObject({ model: pick, model_source: "launch" });
      }, undefined, undefined, undefined, { argv: ["--resume", sessionId!] });

      // Negative control: the same id from another cwd fails the start.
      await expect(nativeRun(config("workspace-write"), other, (host) => host.closed, undefined, undefined, undefined,
        { argv: ["--resume", sessionId!] })).rejects.toThrow("grok could not resume the session");
    } finally {
      removeGrokState(cwd);
      removeGrokState(other);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  }, 600_000);

  it("enforces the new launch profile, not the one the session was saved with", async () => {
    const cwd = mkdtempSync(join(homedir(), ".kaoiro-grok-resume-perm-"));
    const reports = mkdtempSync(join(tmpdir(), "kaoiro-grok-resume-report-"));
    const report = join(reports, "result.json");
    const inside = join(cwd, "inside");
    const script = join(cwd, "write-probe.py");
    writeFileSync(script, `import json, pathlib
try:
 pathlib.Path(${JSON.stringify(inside)}).write_text('fixture')
 ok = True
except OSError:
 ok = False
pathlib.Path(${JSON.stringify(report)}).write_text(json.dumps({'inside': ok}))
print(json.dumps({'inside': ok}))
`);
    try {
      let sessionId: string | undefined;
      await nativeRun(config("workspace-write"), cwd, async (host) => {
        await ready(host);
      }, undefined, undefined, undefined, { onSessionId: (id) => { sessionId = id; } });
      await nativeRun(config("read-only"), cwd, async (host) => {
        await ready(host);
        expect(ext(host)).toMatchObject({ permission: { sandbox: "read-only" } });
        await host.send(`Use run_terminal_command exactly once to run python3 ${JSON.stringify(script)}. ` +
          "Report JSON verbatim; no other tools, retries or commentary.");
      }, undefined, (payload) => JSON.stringify(payload).includes(script), undefined,
      { argv: ["--resume", sessionId!] });
      expect(existsSync(report)).toBe(true);
      expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ inside: false });
      expect(existsSync(inside)).toBe(false);
    } finally {
      removeGrokState(cwd);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(reports, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("removeGrokState", () => {
  it("removes only the session group and the workspace of its own scratch cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "kaoiro-grok-home-"));
    const previous = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const cwd = join(homedir(), ".kaoiro-grok-resume-AbC123");
      const workspaces = join(home, "memory-v2", "workspaces");
      const own = ".kaoiro-grok-resume-AbC123-0123abcd";
      const others = ["work-0123abcd", ".kaoiro-grok-resume-AbC123x-0123abcd",
        ".kaoiro-grok-resume-AbC123-0123abcd-more", ".kaoiro-grok-resume-AbC12-0123abcd"];
      for (const entry of [own, ...others]) mkdirSync(join(workspaces, entry), { recursive: true });
      const sessions = join(home, "sessions");
      mkdirSync(join(sessions, encodeURIComponent(cwd)), { recursive: true });
      mkdirSync(join(sessions, encodeURIComponent(`${cwd}x`)), { recursive: true });
      removeGrokState(cwd);
      expect(readdirSync(workspaces).sort()).toEqual([...others].sort());
      expect(readdirSync(sessions)).toEqual([encodeURIComponent(`${cwd}x`)]);
      // A cwd without the scratch prefix leaves every workspace alone.
      removeGrokState(join(homedir(), "work"));
      expect(readdirSync(workspaces).sort()).toEqual([...others].sort());
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
