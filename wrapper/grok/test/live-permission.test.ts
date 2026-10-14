import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { allowedByRule, liveExecutable } from "./native-support.js";

// The fixtures behind the live tests' permission path (issue 615), checked
// without Grok.
const policy = fileURLToPath(
  new URL("./fixtures/live-permission/hooks/policy.mjs", import.meta.url),
);
const plugin = fileURLToPath(new URL("./fixtures/live-permission", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function decide(
  event: Record<string, unknown>,
  vars: { marker?: string; tools?: string } = {},
): unknown {
  const result = spawnSync(process.execPath, [policy], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", ...event }),
    env: {
      PATH: process.env.PATH,
      ...(vars.marker === undefined ? {} : { KAOIRO_TEST_GROK_ASK_MARKER: vars.marker }),
      ...(vars.tools === undefined ? {} : { KAOIRO_TEST_GROK_ASK_TOOLS: vars.tools }),
    },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const reply = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string };
  };
  expect(reply.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  return reply.hookSpecificOutput.permissionDecision;
}

const terminal = (command: string) => ({
  tool_name: "run_terminal_command",
  tool_input: { command },
});
const configured = { marker: "KAOIRO_HOOK_PROBE", tools: " list_agents , send_to_agent " };

describe("live-permission policy hook", () => {
  it("asks for the marker command and denies other commands", () => {
    expect(decide(terminal("printf KAOIRO_HOOK_PROBE"), configured)).toBe("ask");
    expect(decide(terminal("printf other"), configured)).toBe("deny");
  });
  it("asks for listed kaoiro tools with or without the server prefix, trimming the list", () => {
    for (const name of ["list_agents", "kaoiro__list_agents", "send_to_agent", "kaoiro__send_to_agent"])
      expect(decide({ tool_name: name, tool_input: {} }, configured)).toBe("ask");
  });
  it("denies tools that are not listed", () => {
    for (const name of ["whoami", "kaoiro__whoami", "grep", "read_file"])
      expect(decide({ tool_name: name, tool_input: {} }, configured)).toBe("deny");
  });
  it("does not ask for a marker in another tool's input", () => {
    expect(decide({ tool_name: "read_file", tool_input: { command: "KAOIRO_HOOK_PROBE" } },
      configured)).toBe("deny");
  });
  it("denies everything when nothing is configured", () => {
    expect(decide(terminal("printf KAOIRO_HOOK_PROBE"))).toBe("deny");
    expect(decide({ tool_name: "list_agents", tool_input: {} })).toBe("deny");
  });
});

describe("the live tests' answer rule", () => {
  const rule = { marker: "KAOIRO_HOOK_PROBE", tools: ["list_agents"] };
  const ask = (input: unknown) => allowedByRule({ request_id: "r", tool_name: "t", input }, rule);
  it("allows the marker command and listed tools, with or without the server prefix", () => {
    expect(ask({ command: "printf KAOIRO_HOOK_PROBE" })).toBe(true);
    expect(ask({ tool_name: "list_agents" })).toBe(true);
    expect(ask({ tool_name: "kaoiro__list_agents" })).toBe(true);
  });
  it("denies other commands, unlisted tools and missing input", () => {
    expect(ask({ command: "printf other" })).toBe(false);
    expect(ask({ tool_name: "whoami" })).toBe(false);
    expect(ask(undefined)).toBe(false);
    expect(allowedByRule({ input: { command: "printf KAOIRO_HOOK_PROBE" } }, {})).toBe(false);
  });
});

describe("grok-live launcher", () => {
  function run(args: string[], exitCode = 7): { argv: string[]; status: number | null } {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-grok-live-shim-"));
    scratch.push(dir);
    const record = join(dir, "argv");
    const stub = join(dir, "grok");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit ${exitCode}\n`);
    chmodSync(stub, 0o755);
    const result = spawnSync(liveExecutable, args, {
      env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    return { argv: readFileSync(record, "utf8").trimEnd().split("\n"), status: result.status };
  }
  it("adds the plugin to an agent process right after `agent`", () => {
    const { argv, status } = run(["--no-auto-update", "agent", "--no-leader", "stdio"]);
    expect(argv).toEqual(["--no-auto-update", "agent", "--plugin-dir", plugin, "--no-leader", "stdio"]);
    expect(status).toBe(7);
  });
  it("passes inspect and --version through unchanged", () => {
    expect(run(["--no-auto-update", "inspect", "--json"], 0).argv)
      .toEqual(["--no-auto-update", "inspect", "--json"]);
    expect(run(["--no-auto-update", "--version"], 3)).toEqual({
      argv: ["--no-auto-update", "--version"],
      status: 3,
    });
  });
  it("is committed as an executable file", () => {
    const entry = execFileSync("git", ["ls-files", "-s", "--", liveExecutable], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(entry.split(" ")[0]).toBe("100755");
  });
});
