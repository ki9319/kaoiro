#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_RECORD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tmp", "test-runs.jsonl");
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Counts are summed over every summary line seen, because `pnpm -r` prints one
// summary per package. A runner whose summary is not recognised yields null.
export function createCountParser() {
  const counts = {};
  const add = (runner, key, value) => {
    counts[runner] ??= {};
    counts[runner][key] = (counts[runner][key] ?? 0) + value;
  };
  const line = (text) => {
    text = text.replace(ANSI, "");
    const vitest = /(?:^|[\s:])Tests\s+(.*?)\s*\((\d+)\)\s*$/.exec(text);
    if (vitest) {
      add("vitest", "total", Number(vitest[2]));
      for (const [, n, label] of vitest[1].matchAll(/(\d+) (failed|passed|skipped|todo)/g)) add("vitest", label, Number(n));
      return;
    }
    const nodeTest = /(?:^|[\s:])# (tests|pass|fail) (\d+)\s*$/.exec(text);
    if (nodeTest) {
      add("node:test", { tests: "total", pass: "passed", fail: "failed" }[nodeTest[1]], Number(nodeTest[2]));
      return;
    }
    const mix = /(\d+) tests?, (\d+) failures?/.exec(text);
    if (mix) {
      add("mix", "total", Number(mix[1]));
      add("mix", "failed", Number(mix[2]));
    }
  };
  // Each stream keeps its own unfinished line and its own UTF-8 decoder, so
  // output from two pipes never joins and a character split across chunks is
  // decoded whole.
  const streams = new Map();
  const state = (name) => {
    if (!streams.has(name)) streams.set(name, { decoder: new StringDecoder("utf8"), pending: "" });
    return streams.get(name);
  };
  const feed = (stream, text) => {
    const lines = (stream.pending + text).split("\n");
    stream.pending = lines.pop();
    lines.forEach(line);
  };
  return {
    push(chunk, name = "stdout") {
      const stream = state(name);
      feed(stream, typeof chunk === "string" ? chunk : stream.decoder.write(chunk));
    },
    result() {
      for (const stream of streams.values()) {
        if (stream.pending) line(stream.pending);
        stream.pending = "";
      }
      return Object.keys(counts).length ? counts : null;
    },
  };
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function exitCodeOf(status, signal) {
  if (typeof status === "number") return status;
  const number = signal ? constants.signals[signal] : undefined;
  return typeof number === "number" ? 128 + number : 127;
}

export function buildRecord({ command, cwd, started, ended, exit_code, signal = null, error = null, revision, dirty, extra = {} }) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return {
    schema: 1,
    revision: revision ?? git(cwd, ["rev-parse", "HEAD"]),
    dirty: dirty ?? (git(cwd, ["status", "--porcelain", "--untracked-files=no"]) ? true : top === null ? null : false),
    command,
    cwd_relative: top === null ? null : relative(top, cwd) || ".",
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: ended - started,
    exit_code,
    signal,
    error,
    stage_failed: exit_code === 0 ? null : "suite",
    failure: null,
    steps: [],
    counts: null,
    ...extra,
  };
}

// Observation must not change the run: a record that cannot be written only warns.
export function writeRecord(record, recordFile, stderr = process.stderr) {
  stderr.write(`KAOIRO_TEST_RUN ${JSON.stringify(record)}\n`);
  try {
    mkdirSync(dirname(recordFile), { recursive: true });
    appendFileSync(recordFile, `${JSON.stringify(record)}\n`);
  } catch (error) {
    stderr.write(`run-recorded: cannot write ${recordFile}: ${error.code ?? error.message}\n`);
  }
}

export async function runRecorded({ command, cwd = process.cwd(), recordFile = DEFAULT_RECORD, env = process.env, stdout = process.stdout, stderr = process.stderr }) {
  const started = new Date();
  const parser = createCountParser();
  const outcome = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["inherit", "pipe", "pipe"] });
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    for (const [name, stream, sink] of [["stdout", child.stdout, stdout], ["stderr", child.stderr, stderr]]) {
      stream.on("data", (chunk) => {
        sink.write(chunk);
        parser.push(chunk, name);
      });
    }
    child.on("error", (error) => settle({ status: null, signal: null, error: error.code ?? error.message }));
    child.on("close", (status, signal) => settle({ status, signal, error: null }));
  });
  const record = buildRecord({
    command, cwd, started, ended: new Date(),
    exit_code: exitCodeOf(outcome.status, outcome.signal), signal: outcome.signal, error: outcome.error,
    extra: { counts: parser.result() },
  });
  writeRecord(record, recordFile, stderr);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let recordFile = DEFAULT_RECORD;
  while (args.length && args[0] !== "--") {
    if (args[0] === "--record" && args.length > 1) {
      recordFile = args[1];
      args.splice(0, 2);
    } else {
      args.length = 0;
    }
  }
  if (args[0] === "--") args.shift();
  if (!args.length) {
    process.stderr.write("usage: run-recorded.mjs [--record FILE] -- <command> [args...]\n");
    process.exitCode = 2;
  } else {
    process.exitCode = (await runRecorded({ command: args, recordFile })).exit_code;
  }
}
