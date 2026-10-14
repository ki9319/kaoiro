#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
if (process.argv.includes("--version")) {
  console.log("grok fixture 1.0.52");
  process.exit(0);
}
if (process.argv.includes("inspect")) {
  if (process.env.KAOIRO_TEST_GROK_INSPECT_FAIL === "1") process.exit(2);
  if (process.env.KAOIRO_TEST_GROK_INSPECT_UNKNOWN === "1") {
    console.log('{"future":true}');
    process.exit(0);
  }
  if (process.env.KAOIRO_TEST_GROK_INSPECT_HANG === "1") {
    if (process.env.KAOIRO_TEST_GROK_PID_FILE)
      writeFileSync(process.env.KAOIRO_TEST_GROK_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  console.log(
    JSON.stringify({
      permissions: {
        sources: ["fixture"],
        loaded: 1,
        skipped: [],
        managedSettingsActive: false,
      },
      externalCompat: {
        cells: [
          {
            vendor: "claude",
            surface: "hooks",
            enabled: true,
            source: "config",
          },
        ],
      },
    }),
  );
  process.exit(0);
}
const sid = "fixture-session";
const record = (event, extra = {}) => {
  if (process.env.KAOIRO_TEST_GROK_EVENTS)
    appendFileSync(process.env.KAOIRO_TEST_GROK_EVENTS, JSON.stringify({ event, pid: process.pid,
      profile: process.env.GROK_SANDBOX, ...extra }) + "\n");
};
record("spawn");
if (process.env.KAOIRO_TEST_GROK_IGNORE_TERM === "1") {
  setInterval(() => {}, 1000);
  const child = spawn(process.execPath, [
    "-e",
    'process.on("SIGTERM",()=>{});console.log("ready");' +
      "setInterval(()=>{},1000);",
  ]);
  child.stdout.once("data", () => {
    if (process.env.KAOIRO_TEST_GROK_PID_FILE)
      writeFileSync(process.env.KAOIRO_TEST_GROK_PID_FILE, String(child.pid));
  });
}
let client;
let transport;
// Settles when the MCP connection attempt has ended, whatever its outcome.
let connecting = Promise.resolve();
let prompt;
let memory = "";
let rules = "";
const reply = (id, result) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    }) + "\n",
  );
const notification = (method, params) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }) + "\n",
  );
const update = (data) =>
  notification("session/update", {
    sessionId: sid,
    update: data,
  });
const textChunk = (text) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const finish = (id, text, stopReason = "end_turn", category) => {
  if (text)
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  notification("_x.ai/session_notification", {
    sessionId: sid,
    update: { sessionUpdate: "turn_completed", prompt_id: String(id) },
  });
  reply(id, {
    stopReason,
    _meta: {
      ...(text === "no-prompt-id" ? {} : { promptId: String(id) }),
      requestId: String(id),
      ...(category ? { cancellationCategory: category } : {}),
    },
  });
  prompt = undefined;
};
process.on("SIGTERM", () => {
  if (process.env.KAOIRO_TEST_GROK_IGNORE_TERM === "1") return;
  record("exit");
  void client?.close().finally(() => process.exit(0));
  if (!client) process.exit(0);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const msg = JSON.parse(line);
    record(msg.method ?? "response", { ...(msg.params?.sessionId ? { sessionId: msg.params.sessionId } : {}) });
    const fault = process.env.KAOIRO_TEST_GROK_SWITCH_FAULT;
    if (fault && process.env.GROK_SANDBOX === "read-only") {
      if (fault === `${msg.method}:exit`) process.exit(13);
      if (fault === `${msg.method}:close`) { process.stdout.end(); return; }
      if (fault === `${msg.method}:hang`) return;
      if (fault === `${msg.method}:fail`) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
          error: { code: -32603, message: "fixture fault" } }) + "\n");
        return;
      }
    }
    switch (msg.method) {
      case "initialize":
        if (process.env.KAOIRO_TEST_GROK_INITIALIZE_FAIL === "1") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32603, message: "LAUNCH_ERROR_BODY_MARKER" },
          }) + "\n");
          break;
        }
        reply(msg.id, {
          protocolVersion: 1,
          agentCapabilities:
            process.env.KAOIRO_TEST_GROK_MCP_MODE === "no-http"
              ? {}
              : { loadSession: true, mcpCapabilities: { http: true, sse: true } },
          authMethods: [],
        });
        break;
      case "session/load":
      case "session/new": {
        const loading = msg.method === "session/load";
        if (!loading) rules = msg.params._meta.rules;
        if (loading) {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY_ONLY" } });
          notification("_x.ai/session_notification", {
            sessionId: sid, update: { sessionUpdate: "turn_completed", prompt_id: "replayed-id" },
          });
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "replay-permission",
            method: "session/request_permission", params: { sessionId: sid,
              toolCall: { toolCallId: "replayed-tool", title: "replay" },
              options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } }) + "\n");
        }
        const mcp = msg.params.mcpServers[0];
        const mode = process.env.KAOIRO_TEST_GROK_MCP_MODE ?? "ok";
        const headers = Object.fromEntries(
          (mcp.headers ?? []).map((h) => [h.name, h.value]),
        );
        const token = /^Bearer (.+)$/.exec(headers.Authorization ?? "")?.[1];
        // Test-only side channels: the token this process received, and whether
        // it can be found in this process's argv or environment.
        if (token && process.env.KAOIRO_TEST_GROK_TOKEN_FILE)
          writeFileSync(process.env.KAOIRO_TEST_GROK_TOKEN_FILE, token);
        if (token && process.env.KAOIRO_TEST_GROK_SCAN_FILE)
          writeFileSync(
            process.env.KAOIRO_TEST_GROK_SCAN_FILE,
            JSON.stringify({
              type: mcp.type,
              url: mcp.url,
              tokenInArgv: JSON.stringify(process.argv).includes(token),
              tokenInEnv: JSON.stringify(process.env).includes(token),
              tokenInUrl: String(mcp.url).includes(token),
            }),
          );
        // Like Grok, reply first and connect afterwards, and carry on without
        // the server when the connection fails.
        reply(msg.id, loading ? {} : { sessionId: sid });
        if (loading && process.env.GROK_SANDBOX === "read-only" && fault?.startsWith("readiness:")) {
          if (fault.endsWith(":exit")) setTimeout(() => process.exit(13), 30);
          if (fault.endsWith(":close")) setTimeout(() => process.stdout.end(), 30);
          break;
        }
        if (mode !== "never-connect") {
          const sent =
            mode === "drop-headers"
              ? {}
              : mode === "wrong-token"
                ? { Authorization: `Bearer ${"x".repeat(token?.length ?? 43)}` }
                : headers;
          transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
            requestInit: { headers: sent },
          });
          client = new Client({ name: "grok-fixture", version: "0" });
          connecting = (async () => {
            await client.connect(transport);
            await client.listTools();
          })().catch(() => {});
        }
        break;
      }
      case "session/prompt": {
        prompt = msg.id;
        const text = msg.params.prompt[0].text;
        if (["chunks", "fail-chunks", "hold-chunks"].includes(text)) {
          for (const chunk of ["Hello", " ", "world"]) textChunk(chunk);
          if (text === "hold-chunks") break;
          if (text === "fail-chunks") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              error: { code: -32603, message: "fixture turn failure" },
            }) + "\n");
            prompt = undefined;
          } else finish(msg.id, "");
          break;
        }
        if (text === "large-chunks") {
          textChunk("x".repeat(10 * 1024));
          textChunk("x".repeat(10 * 1024));
          finish(msg.id, "");
          break;
        }
        if (text === "ordered-chunks") {
          textChunk("Before");
          update({ sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private thought" } });
          textChunk(" tool");
          update({ sessionUpdate: "tool_call_update",
            toolCallId: "ordered", status: "in_progress" });
          update({ sessionUpdate: "tool_call", toolCallId: "ordered", title: "probe",
            status: "in_progress", kind: "other" });
          textChunk("After");
          update({ sessionUpdate: "tool_call_update", toolCallId: "ordered", status: "completed" });
          update({ sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private thought" } });
          textChunk(" tool");
          finish(msg.id, "");
          break;
        }
        if (text === "non-text-chunks") {
          update({ sessionUpdate: "agent_message_chunk", content: {
            type: "image", data: "", mimeType: "image/png" } });
          update({ sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private thought" } });
          finish(msg.id, "");
          break;
        }
        if (text === "close-output") {
          if (process.env.KAOIRO_TEST_GROK_PID_FILE)
            writeFileSync(process.env.KAOIRO_TEST_GROK_PID_FILE,
              String(process.pid));
          process.stdout.end();
          setInterval(() => {}, 1000);
          break;
        }
        if (text === "fail-turn") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32603, message: "TURN_FAILURE_BODY_MARKER" },
          }) + "\n");
          prompt = undefined;
          break;
        }
        if (text === "large-tool") {
          update({
            sessionUpdate: "tool_call", toolCallId: "large",
            title: "large result", kind: "other", status: "in_progress",
          });
          update({
            sessionUpdate: "tool_call_update", toolCallId: "large",
            status: "completed", content: [{ type: "content", content: {
              type: "text",
              text: "LARGE_TOOL_BODY_MARKER" + "x".repeat(5 * 1024 * 1024),
            } }],
          });
          finish(msg.id, "large tool completed");
          break;
        }
        if (text === "exit") {
          process.exit(9);
        }
        if (text === "canary") {
          // A value the test planted, carried through the real paths: the
          // assistant text (an envelope) and a notification's prompt_id (a
          // metadata-tee record).
          const canary = process.env.KAOIRO_TEST_GROK_CANARY;
          notification("_x.ai/session_notification", {
            sessionId: sid,
            update: { sessionUpdate: "turn_completed", prompt_id: canary },
          });
          finish(msg.id, canary);
          break;
        }
        if (text === "sleep" || text === "stubborn") {
          const child = spawn(process.execPath, [
            "-e",
            "setInterval(() => {}, 1000)",
          ]);
          if (process.env.KAOIRO_TEST_GROK_PID_FILE) {
            writeFileSync(
              process.env.KAOIRO_TEST_GROK_PID_FILE,
              String(child.pid),
            );
          }
          update({
            sessionUpdate: "tool_call",
            toolCallId: "long",
            title: "sleep",
            status: "in_progress",
            kind: "execute",
          });
          break;
        }
        if (text === "permission") {
          notification("_x.ai/session_notification", {
            session_id: sid,
            notification: { type: "pending_interaction", kind: "permission" },
          });
          textChunk("Before");
          textChunk(" permission");
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "permission",
              method: "session/request_permission",
              params: {
                sessionId: sid,
                toolCall: {
                  toolCallId: "permission-tool",
                  title: "write fixture",
                },
                options: [
                  { optionId: "yes", name: "Allow", kind: "allow_once" },
                  { optionId: "no", name: "Reject", kind: "reject_once" },
                ],
              },
            }) + "\n",
          );
          setTimeout(
            () =>
              update({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "BROKER_WAIT_PROGRESS" },
              }),
            25,
          );
          break;
        }
        if (text === "pending-only") {
          notification("_x.ai/session_notification", {
            session_id: sid,
            notification: { type: "pending_interaction", kind: "permission" },
          });
        }
        if (text === "parallel") {
          for (const id of ["a", "b"])
            update({
              sessionUpdate: "tool_call",
              toolCallId: id,
              title: id,
              kind: "other",
              status: "in_progress",
            });
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "a",
            status: "completed",
          });
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "B_STILL_PENDING" },
          });
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "b",
            status: "completed",
          });
          finish(msg.id, "finished");
          break;
        }
        if (text === "unknown") {
          process.stderr.write("UNKNOWN_BODY_MARKER\n");
          update({
            sessionUpdate: "future_variant",
            content: "UNKNOWN_BODY_MARKER",
          });
        }
        if (text === "tool" || text === "error-tool" || text === "hang-tool") {
          update({
            sessionUpdate: "tool_call",
            toolCallId: "mcp",
            title: "probe",
            status: "in_progress",
            kind: "other",
          });
          await connecting;
          const result = await client.callTool({
            name: "probe",
            arguments: { value: 7 },
          });
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "mcp",
            status: "completed",
          });
          finish(msg.id, JSON.stringify(result));
          break;
        }
        if (text.startsWith("[Inter-agent message")) {
          if (process.env.KAOIRO_TEST_GROK_FAIL_PEER === "1") process.exit(9);
          const match = /conversation_id="([^"]+)"/.exec(text);
          await connecting;
          const result = await client.callTool({
            name: "send_to_agent",
            arguments: {
              to: "peer",
              conversation_id: match?.[1],
              kind: "response",
              body: "fixture reply",
              done: true,
              propose_next: "",
            },
          });
          finish(msg.id, JSON.stringify(result));
          break;
        }
        if (text.startsWith("remember ")) memory = text.slice(9);
        finish(
          msg.id,
          text === "recall" ? memory : text === "rules" ? rules : text,
        );
        break;
      }
      case "session/cancel":
        if (prompt !== undefined)
          finish(prompt, "", "cancelled", "MidTurnAbort");
        break;
      default:
        if (msg.id === "replay-permission") record("replay-permission-response", { outcome: msg.result?.outcome?.outcome });
        if (msg.id === "permission" && msg.result && prompt !== undefined) {
          finish(prompt, "", "cancelled", "PermissionRejected");
        }
    }
  })().catch(() => process.exit(10));
});
