#!/usr/bin/env node
// Test-only launcher for the live tests (issue 615): runs the real grok from
// PATH and loads the live-permission plugin into an agent process. Other
// invocations (inspect, --version) pass through unchanged. It stays in the
// host's process group, so the host's group kill reaches grok too.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("./live-permission", import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("agent");
const forwarded =
  at < 0
    ? args
    : [...args.slice(0, at + 1), "--plugin-dir", plugin, ...args.slice(at + 1)];
const child = spawn("grok", forwarded, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(127));
child.on("exit", (code, signal) =>
  process.exit(signal ? 128 + constants.signals[signal] : (code ?? 1)),
);
