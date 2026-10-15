import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGrokProbe } from "../../../runner/src/grok_acp_probe.js";
import { probeGrokCatalog } from "../../../runner/src/grok-catalog.js";
import { listGrokSessions } from "../../../runner/src/grok_sessions.js";
import { makeGrokScratch, removeGrokState } from "./grok-state.js";

// Whether the runner's Grok probes attempt any request that could spend
// quota (issue #646, design: issue #592 r3, "What the quota acceptance
// proves"). Grok runs in a network namespace with loopback only, next to a
// recorder that refuses every request on its base URLs and proxies. A prompt
// must first show its model requests there (the positive control); then the
// catalog probe and the session-list probe, through their production
// functions, may attempt nothing outside the GETs measured for Grok 1.0.52.
// It proves nothing about billed tokens, other Grok versions, or traffic
// that ignores both the base URLs and the proxy variables.

const live = process.env.KAOIRO_LIVE_GROK === "1";
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PORT = "18594";
const MEASURED_GETS = new Set([
  "/", "/v1/models", "/v1/settings", "/v1/feedback/config", "/v1/bundle/archive", "/v1/subagents/bundle",
]);

interface Entry { method: string; path?: string }

function classify(entries: Entry[]) {
  const modelRequests = entries.filter((e) => e.method === "POST" && e.path === "/v1/responses").length;
  const connects = entries.filter((e) => e.method === "CONNECT").length;
  const outside = entries.filter((e) => !(e.method === "GET" && e.path !== undefined && MEASURED_GETS.has(e.path))).length;
  return { requests: entries.length, modelRequests, connects, outside };
}

const read = (log: string): Entry[] => existsSync(log)
  ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];

describe("classify", () => {
  it("counts only a POST to /v1/responses as a model request", () => {
    expect(classify([{ method: "POST", path: "/v1/responses" }, { method: "POST", path: "/v1/chat" },
      { method: "GET", path: "/v1/responses" }, { method: "CONNECT" }])).toMatchObject({ modelRequests: 1, connects: 1 });
  });

  it("puts everything but a measured GET outside the set", () => {
    const inside = [...MEASURED_GETS].map((path) => ({ method: "GET", path }));
    expect(classify(inside)).toMatchObject({ requests: 6, outside: 0, modelRequests: 0, connects: 0 });
    expect(classify([{ method: "GET", path: "/v1/other" }, { method: "HEAD", path: "/" },
      { method: "POST", path: "/v1/settings" }, { method: "CONNECT" }, { method: "GET" }]).outside).toBe(5);
  });
});

describe.skipIf(!live)("catalog quota (native)", () => {
  it("attempts no request outside the measured GET set from the catalog and list probes", async () => {
    const grok = execFileSync("sh", ["-c", "command -v grok"], { encoding: "utf8" }).trim();
    const logs = mkdtempSync(join(tmpdir(), "kaoiro-grok-quota-"));
    const cwd = makeGrokScratch("quota", "tmp");
    const base = `http://127.0.0.1:${PORT}`;
    const proxied = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy",
      "all_proxy"].map((name) => [name, base]));
    const transport = (log: string) => ({
      executable: join(fixtures, "quota-netns.sh"),
      env: { ...process.env, ...proxied, NO_PROXY: "", no_proxy: "",
        GROK_CLI_CHAT_PROXY_BASE_URL: `${base}/v1`, GROK_XAI_API_BASE_URL: `${base}/v1`,
        KAOIRO_QUOTA_RECORDER: join(fixtures, "quota-recorder.py"), KAOIRO_QUOTA_PORT: PORT,
        KAOIRO_QUOTA_LOG: log, KAOIRO_QUOTA_GROK: grok },
    });
    const results: Record<string, unknown> = {
      grok: execFileSync(grok, ["--version"], { encoding: "utf8" }).trim(),
    };
    try {
      // Positive control: a prompt, watched until its first model request
      // or 45 s.
      const positiveLog = join(logs, "positive.jsonl");
      await runGrokProbe({ cwd, ...transport(positiveLog), deadlineMs: 60_000 }, async (call) => {
        const made = (await call("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
        void call("session/prompt", { sessionId: made.sessionId,
          prompt: [{ type: "text", text: "Reply with the single word OK." }] }).catch(() => {});
        const until = Date.now() + 45_000;
        while (classify(read(positiveLog)).modelRequests === 0 && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(existsSync(`${positiveLog}.ready`), "the recorder never started in the namespace").toBe(true);
      results.positive = classify(read(positiveLog));
      expect(classify(read(positiveLog)).modelRequests,
        "model requests are not observable under this transport").toBeGreaterThan(0);

      // Negative check: the production catalog and list probes. The catalog
      // probe runs in the scratch cwd, so whatever it might leave there is
      // cleaned with it.
      const catalogLog = join(logs, "catalog.jsonl");
      results.catalogRead = await probeGrokCatalog({ cwd, ...transport(catalogLog) }).then(() => true, () => false);
      const listLog = join(logs, "list.jsonl");
      await listGrokSessions(cwd, transport(listLog));
      for (const [name, log] of [["catalog", catalogLog], ["list", listLog]] as const) {
        expect(existsSync(`${log}.ready`), `the recorder never started for the ${name} probe`).toBe(true);
        const counts = classify(read(log));
        results[name] = counts;
        expect(counts, `the ${name} probe`).toMatchObject({ outside: 0, connects: 0, modelRequests: 0 });
      }
    } finally {
      if (process.env.KAOIRO_QUOTA_REPORT) writeFileSync(process.env.KAOIRO_QUOTA_REPORT, JSON.stringify(results, null, 2));
      removeGrokState(cwd);
      rmSync(logs, { recursive: true, force: true });
    }
  }, 180_000);
});
