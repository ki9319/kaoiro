import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../codex-backend-compatibility.mjs";

const HOST = "legacy-host";
const RUNNER_SHA = "475e0d5d01d173b46be3bbb7b28564ccf8743abd";
const CONFIG_HASH = "a".repeat(64);
const NEXT_CONFIG_HASH = "b".repeat(64);
const INVOCATION_ID = "1234567890abcdef1234567890abcdef";
const AGENT_ID = `${HOST}.agent`;

function observation(overrides = {}) {
  return {
    schema: 1,
    host: HOST,
    rows: [{
      id: AGENT_ID,
      directory: true,
      pointer: "non_nil",
      engine: "codex",
      live: false,
      connected: false,
      reset_pending: false,
      transition_pending: false,
      ...overrides,
    }],
  };
}

function emptyObservation() {
  return { schema: 1, host: HOST, rows: [] };
}

function runnerObservation(overrides = {}) {
  return {
    host: HOST,
    configuredBackend: "omitted",
    appliedBackend: "exec",
    appliedReceipt: { backend: "exec", source: "wrapper", timestampUs: 2_000_000 },
    configHash: CONFIG_HASH,
    configMtimeMs: 1_000,
    runnerSha: RUNNER_SHA,
    invocationId: INVOCATION_ID,
    ...overrides,
  };
}

function originEvidence(runner = runnerObservation()) {
  return {
    schema: 1,
    host: HOST,
    config_sha256: runner.configHash,
    config_mtime_ms: runner.configMtimeMs,
    runner_sha: runner.runnerSha,
    invocation_id: runner.invocationId,
    all_relevant_sessions_covered: true,
    origin_source: "measured",
    agent_ids: [AGENT_ID],
    agents: [{ id: AGENT_ID, origin: "exec", complete: true }],
  };
}

function emptyOriginEvidence(runner = runnerObservation()) {
  return {
    ...originEvidence(runner),
    agent_ids: [],
    agents: [],
  };
}

function makeAdapters({ hosts = [], runners = [], evidence, acknowledge = true, fail = {} } = {}) {
  const calls = { host: 0, runner: 0, origin: 0, cursor: 0, writes: 0, acknowledgements: 0, restores: 0 };
  const fallbackHost = observation();
  const beforeRunner = runnerObservation();
  const afterRunner = runnerObservation({
    configuredBackend: "exec",
    appliedBackend: "exec",
    appliedReceipt: { backend: "exec", source: "reload", timestampUs: 2_500_000 },
    configHash: NEXT_CONFIG_HASH,
    configMtimeMs: 2_000,
  });
  return {
    calls,
    adapters: {
      async observeHost() {
        calls.host += 1;
        if (fail.hostAt === calls.host) throw new Error("unavailable");
        return structuredClone(hosts[calls.host - 1] ?? fallbackHost);
      },
      async observeRunner() {
        calls.runner += 1;
        if (fail.runnerAt === calls.runner) throw new Error("unavailable");
        return structuredClone(runners[calls.runner - 1] ?? (calls.runner >= 3 ? afterRunner : beforeRunner));
      },
      async readOriginEvidence() {
        calls.origin += 1;
        if (fail.origin) throw new Error("unavailable");
        return structuredClone(evidence ?? originEvidence(beforeRunner));
      },
      async captureAckCursor() {
        calls.cursor += 1;
        return "cursor-before-write";
      },
      async writeBackendExec() {
        calls.writes += 1;
        if (fail.write) throw new Error("write failed");
      },
      async waitForAppliedBackendExec() {
        calls.acknowledgements += 1;
        if (fail.ack) throw new Error("ack adapter failed");
        return acknowledge;
      },
      async restore() {
        calls.restores += 1;
      },
    },
  };
}

function argv(phase = "prepare") {
  return [
    "--phase", phase,
    "--host", HOST,
    "--runner-sha", RUNNER_SHA,
    "--compose-file", "compose.yml",
    "--runner-config", "runner.config.json",
    "--runner-unit", "kaoiro-runner.service",
    "--origin-evidence", "origin-evidence.json",
  ];
}

function io() {
  return {
    stdout: { text: "", write(value) { this.text += value; } },
    stderr: { text: "", write(value) { this.text += value; } },
  };
}

test("prepare pins omitted legacy exec once and confirms the applied selection", async () => {
  const { adapters, calls } = makeAdapters();
  const output = io();

  assert.equal(await main(argv(), adapters, output), 0);
  assert.deepEqual(JSON.parse(output.stdout.text), {
    phase: "prepare", status: "prepared", host: HOST, backend: "exec",
  });
  assert.equal(calls.writes, 1);
  assert.equal(calls.acknowledgements, 1);
  assert.equal(calls.restores, 0);
});

test("a positive pending transition blocks the product entry before the config write", async () => {
  const pending = observation({ transition_pending: true });
  const { adapters, calls } = makeAdapters({ hosts: [pending, pending] });
  const output = io();

  const result = await main(argv(), adapters, output);
  assert.equal(calls.origin, 0);
  assert.equal(calls.cursor, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.restores, 0);
  assert.equal(result, 1);
});

test("the pre-write lifecycle gate keeps pending work from reaching the write boundary", async () => {
  const { adapters, calls } = makeAdapters({ hosts: [observation(), observation({ transition_pending: true })] });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 1);
  assert.match(output.stderr.text, /stopped \(pending-lifecycle\)/);
  assert.equal(calls.writes, 0);
  assert.equal(calls.restores, 0);
});

test("the pre-write stability gate rejects host and runner changes", async (t) => {
  await t.test("pointer status changes without changing origin evidence", async () => {
    const { adapters, calls } = makeAdapters({ hosts: [observation(), observation({ pointer: "nil" })] });
    const output = io();

    assert.equal(await main(argv(), adapters, output), 1);
    assert.match(output.stderr.text, /stopped \(observation-changed\)/);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });

  await t.test("runner receipt changes without changing origin evidence", async () => {
    const before = runnerObservation();
    const changed = runnerObservation({
      appliedReceipt: { ...before.appliedReceipt, timestampUs: before.appliedReceipt.timestampUs + 1 },
    });
    const { adapters, calls } = makeAdapters({ runners: [before, changed] });
    const output = io();

    assert.equal(await main(argv(), adapters, output), 1);
    assert.match(output.stderr.text, /stopped \(observation-changed\)/);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });
});

test("an unavailable initial or immediate pre-write server observation makes no changes", async (t) => {
  await t.test("initial", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { hostAt: 1 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });

  await t.test("pre-write recheck", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { hostAt: 2 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });
});

test("an unknown engine observation stops before origin evidence, cursor capture, or mutation", async () => {
  const { adapters, calls } = makeAdapters({ hosts: [observation({ engine: null })] });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 1);
  assert.match(output.stderr.text, /stopped \(engine-unknown\)/);
  assert.equal(calls.origin, 0);
  assert.equal(calls.cursor, 0);
  assert.equal(calls.writes, 0);
  assert.equal(calls.restores, 0);
});

test("an unavailable runner observation makes no changes", async (t) => {
  await t.test("initial", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { runnerAt: 1 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });

  await t.test("pre-write recheck", async () => {
    const empty = emptyObservation();
    const { adapters, calls } = makeAdapters({
      hosts: [empty, empty],
      evidence: emptyOriginEvidence(),
      fail: { runnerAt: 2 },
    });
    const result = await main(argv(), adapters, io());
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
    assert.equal(result, 1);
  });
});

test("a failed applied-selection acknowledgement does not trigger a second mutation or restore", async () => {
  const { adapters, calls } = makeAdapters({ acknowledge: false });

  const result = await main(argv(), adapters, io());
  assert.equal(calls.writes, 1);
  assert.equal(calls.acknowledgements, 1);
  assert.equal(calls.restores, 0);
  assert.equal(calls.runner, 2);
  assert.equal(result, 1);
});

test("post-write applied selection requires a reload receipt", async () => {
  const after = runnerObservation({
    configuredBackend: "exec",
    appliedBackend: "exec",
    appliedReceipt: { backend: "exec", source: "wrapper", timestampUs: 3_000_000 },
    configHash: NEXT_CONFIG_HASH,
    configMtimeMs: 2_000,
  });
  const { adapters, calls } = makeAdapters({ runners: [undefined, undefined, after] });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 1);
  assert.match(output.stderr.text, /stopped \(applied-selection-unverified\)/);
  assert.equal(calls.writes, 1);
  assert.equal(calls.acknowledgements, 1);
  assert.equal(calls.restores, 0);
});

test("unknown origin, changed roster, and malformed phase all refuse before mutation", async (t) => {
  await t.test("unknown origin", async () => {
    const evidence = originEvidence();
    evidence.agents[0].origin = "unknown";
    const { adapters, calls } = makeAdapters({ evidence });
    assert.equal(await main(argv(), adapters, io()), 1);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });

  await t.test("changed roster", async () => {
    const { adapters, calls } = makeAdapters({ hosts: [observation(), observation({ id: `${HOST}.new-agent` })] });
    assert.equal(await main(argv(), adapters, io()), 1);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });

  await t.test("non-U1 phase", async () => {
    const { adapters, calls } = makeAdapters();
    assert.equal(await main(argv("restore-fresh"), adapters, io()), 1);
    assert.equal(calls.host, 0);
    assert.equal(calls.writes, 0);
    assert.equal(calls.restores, 0);
  });
});

test("an explicit complete routing attestation can resolve directly unknown origin", async () => {
  const evidence = originEvidence();
  evidence.origin_source = "operator-attestation";
  evidence.agents[0].origin = "unknown";
  evidence.attestation = {
    accepted: true,
    attested_at: "2026-10-27T00:00:00Z",
    scope: "affected host and all relevant saved sessions",
    release_range: "complete applicable runner history",
    statement: "Every relevant route used the legacy exec backend; no imported app-server ID exists.",
    unknown_origin_rows: [AGENT_ID],
    contrary_rows: [],
    unresolved_rows: [],
  };
  const { adapters, calls } = makeAdapters({ evidence });
  const output = io();

  assert.equal(await main(argv(), adapters, output), 0);
  assert.equal(JSON.parse(output.stdout.text).status, "prepared");
  assert.equal(calls.writes, 1);
  assert.equal(calls.restores, 0);
});

test("an already-applied explicit setting is retained without origin probing or writes", async (t) => {
  for (const backend of ["exec", "app-server"]) {
    await t.test(backend, async () => {
      const explicit = runnerObservation({ configuredBackend: backend, appliedBackend: backend });
      const { adapters, calls } = makeAdapters({ runners: [explicit] });
      const output = io();

      assert.equal(await main(argv(), adapters, output), 0);
      assert.equal(JSON.parse(output.stdout.text).status, "already-explicit");
      assert.equal(calls.origin, 0);
      assert.equal(calls.host, 0);
      assert.equal(calls.writes, 0);
      assert.equal(calls.restores, 0);
    });
  }
});

function localFiles(t) {
  const directory = mkdtempSync(join(tmpdir(), "codex-backend-compatibility."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "runner.config.json");
  const evidencePath = join(directory, "origin-evidence.json");
  const configBytes = Buffer.from(`{"host_id":"${HOST}"}\n`);
  writeFileSync(configPath, configBytes, { mode: 0o600 });
  const configMtimeMs = statSync(configPath).mtimeMs;
  const configHash = createHash("sha256").update(configBytes).digest("hex");
  const projection = JSON.parse(readFileSync(new URL("./fixtures/codex-backend/server-observation.json", import.meta.url), "utf8"));
  const agentId = projection.rows[0].id;
  const evidence = {
    schema: 1,
    host: HOST,
    config_sha256: configHash,
    config_mtime_ms: configMtimeMs,
    runner_sha: RUNNER_SHA,
    invocation_id: INVOCATION_ID,
    all_relevant_sessions_covered: true,
    origin_source: "measured",
    agent_ids: [agentId],
    agents: [{ id: agentId, origin: "exec", complete: true }],
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  return { directory, configPath, evidencePath, configBytes, projection };
}

function localArgv(configPath, evidencePath) {
  const args = argv();
  args[args.indexOf("--runner-config") + 1] = configPath;
  args[args.indexOf("--origin-evidence") + 1] = evidencePath;
  return args;
}

function localCommandBoundary({ configPath, projection, failObservationAt = 0, failAck = false, runnerSha = RUNNER_SHA }) {
  const calls = { systemctl: 0, docker: 0, journalRows: 0, runnerIdentity: 0, cursor: 0, acknowledgement: 0 };
  const startup = `runner: host=${HOST} rev=${runnerSha} connecting to wss://example.invalid/runner\n`;

  return {
    calls,
    runCommand(command, args) {
      if (command === "systemctl") {
        calls.systemctl += 1;
        if (failAck && calls.systemctl === 6) return `${"f".repeat(32)}\n`;
        return `${INVOCATION_ID}\n`;
      }

      if (command === "docker") {
        calls.docker += 1;
        if (calls.docker === failObservationAt) throw new Error("captured RPC failure");
        return `${JSON.stringify(projection)}\n`;
      }

      if (command === "journalctl") {
        if (args.includes("--show-cursor")) {
          calls.cursor += 1;
          return "-- cursor: cursor-before-write\n";
        }
        if (args.includes("--grep")) {
          calls.runnerIdentity += 1;
          return startup;
        }
        if (args.some((arg) => arg.startsWith("--after-cursor="))) {
          calls.acknowledgement += 1;
          return "runner: codex backend=exec for subsequent wrappers\n";
        }
        if (args.includes("--output=json")) {
          calls.journalRows += 1;
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          const timestamp = String(Math.floor(statSync(configPath).mtimeMs * 1000) + 1_000_000);
          const message = config.codex?.backend === "exec"
            ? "runner: codex backend=exec for subsequent wrappers"
            : "codex: backend=exec";
          return `${JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: timestamp, _PID: "4242" })}\n`;
        }
      }

      throw new Error(`unexpected command ${command}`);
    },
  };
}

test("the default local adapter prepares with product-shaped command responses and real file operations", async (t) => {
  const files = localFiles(t);
  const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection });
  const output = io();

  assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 0);
  assert.deepEqual(JSON.parse(output.stdout.text), { phase: "prepare", status: "prepared", host: HOST, backend: "exec" });
  assert.equal(boundary.calls.docker, 2);
  assert.equal(boundary.calls.cursor, 1);
  assert.equal(boundary.calls.acknowledgement, 1);
  assert.equal(boundary.calls.journalRows, 3);
  assert.equal(boundary.calls.runnerIdentity, 4);
  assert.deepEqual(JSON.parse(readFileSync(files.configPath, "utf8")).codex, { backend: "exec" });
  assert.equal(statSync(files.configPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(files.directory).sort(), ["origin-evidence.json", "runner.config.json"]);
});

test("the default local adapter rejects unknown runner identity and unknown engine before mutation", async (t) => {
  await t.test("runner startup identity differs from the requested full release SHA", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({
      configPath: files.configPath,
      projection: files.projection,
      runnerSha: "a".repeat(40),
    });
    const before = readFileSync(files.configPath);

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, io(), { runCommand: boundary.runCommand }), 1);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 0);
    assert.equal(boundary.calls.cursor, 0);
  });

  await t.test("directory-only inventory has no engine", async (t) => {
    const files = localFiles(t);
    const projection = structuredClone(files.projection);
    projection.rows[0].engine = null;
    const boundary = localCommandBoundary({ configPath: files.configPath, projection });
    const before = readFileSync(files.configPath);
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(engine-unknown\)/);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 1);
    assert.equal(boundary.calls.cursor, 0);
  });
});

test("the default local adapter observes positive pending state and refuses before preparation", async (t) => {
  const files = localFiles(t);
  const projection = structuredClone(files.projection);
  projection.rows[0].transition_pending = true;
  const boundary = localCommandBoundary({ configPath: files.configPath, projection });
  const before = readFileSync(files.configPath);
  const output = io();

  assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
  assert.match(output.stderr.text, /stopped \(pending-lifecycle\)/);
  assert.deepEqual(readFileSync(files.configPath), before);
  assert.equal(boundary.calls.docker, 1);
  assert.equal(boundary.calls.cursor, 0);
});

test("the default local adapter keeps unavailable observations and failed acknowledgements fail-closed", async (t) => {
  await t.test("initial observation unavailable", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, failObservationAt: 1 });
    const before = readFileSync(files.configPath);

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, io(), { runCommand: boundary.runCommand }), 1);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 1);
    assert.equal(boundary.calls.cursor, 0);
  });

  await t.test("immediate pre-write observation unavailable", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, failObservationAt: 2 });
    const before = readFileSync(files.configPath);

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, io(), { runCommand: boundary.runCommand }), 1);
    assert.deepEqual(readFileSync(files.configPath), before);
    assert.equal(boundary.calls.docker, 2);
    assert.equal(boundary.calls.cursor, 1);
  });

  await t.test("acknowledgement failure leaves the one explicit write and starts no post-write observation", async (t) => {
    const files = localFiles(t);
    const boundary = localCommandBoundary({ configPath: files.configPath, projection: files.projection, failAck: true });
    const output = io();

    assert.equal(await main(localArgv(files.configPath, files.evidencePath), undefined, output, { runCommand: boundary.runCommand }), 1);
    assert.match(output.stderr.text, /stopped \(applied-selection-acknowledgement-missing\)/);
    assert.deepEqual(JSON.parse(readFileSync(files.configPath, "utf8")).codex, { backend: "exec" });
    assert.equal(boundary.calls.docker, 2);
    assert.equal(boundary.calls.journalRows, 2);
    assert.equal(boundary.calls.runnerIdentity, 3);
    assert.equal(boundary.calls.systemctl, 6);
    assert.equal(boundary.calls.acknowledgement, 0);
  });
});
