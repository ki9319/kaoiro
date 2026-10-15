#!/usr/bin/env node
// A stand-in for `grok agent stdio` in runner discovery tests. The scenario
// file (FAKE_GROK_SCENARIO) decides the answers:
//   pages:      { "<cursor or __first__>": result | { error: code } }
//   hang:       never answer session/list
//   initError:  answer initialize with this JSON-RPC error code
//   exitOnList: exit before answering session/list
//   spawnChild: start a sleeping child in the same process group
//   stubbornChild: start a child in the group that ignores SIGTERM; the pid
//               marker is written once its handler is in place
//   listReply:  answer session/list with this body verbatim
// Every request is appended to FAKE_GROK_LOG; FAKE_GROK_PIDS receives
// "<leader pid> <child pid>" once both exist.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const scenario = JSON.parse(readFileSync(process.env.FAKE_GROK_SCENARIO, "utf8"));
const log = process.env.FAKE_GROK_LOG;
const pids = process.env.FAKE_GROK_PIDS;

let child;
const markPids = () => {
  if (!pids) return;
  writeFileSync(`${pids}.tmp`, `${process.pid} ${child?.pid ?? 0}`);
  renameSync(`${pids}.tmp`, pids);
};
if (scenario.stubbornChild) {
  child = spawn(process.execPath, ["-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"],
  { stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.once("data", markPids);
} else {
  if (scenario.spawnChild) child = spawn("sleep", ["30"], { stdio: "ignore" });
  markPids();
}

const reply = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (log) appendFileSync(log, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
    if (message.method === "initialize") {
      if (scenario.initError) reply(message.id, { error: { code: scenario.initError, message: "no" } });
      else {
        // An unsolicited request and a notification, which the probe must
        // refuse and ignore.
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/announcements/update", params: {} })}\n`);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "fs/read_text_file", params: {} })}\n`);
        reply(message.id, { result: { protocolVersion: 1, agentCapabilities: {} } });
      }
    } else if (message.method === "session/list") {
      if (scenario.exitOnList) process.exit(0);
      if (scenario.hang) continue;
      if (scenario.listReply !== undefined) {
        reply(message.id, scenario.listReply);
        continue;
      }
      const page = scenario.pages[message.params?.cursor ?? "__first__"];
      if (page === undefined) reply(message.id, { error: { code: -32603, message: "no page" } });
      else if (page.error !== undefined) reply(message.id, { error: { code: page.error, message: "no" } });
      else reply(message.id, { result: page });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
