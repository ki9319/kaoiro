import "../../../scripts/test/fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { BRANCH, classify, requireRunningContainer } from "../kaoiro-deploy-branch.mjs";

// A fake docker whose behavior is picked by FAKE_DOCKER_SCENARIO, so one
// small script drives every classify() branch without a real daemon.
// `compose ps -a --format {{.Name}} <service>` -> one line per container
// (or none); `inspect <container> --format {{.State.Status}}` -> the
// status string for that scenario's single container.
const FAKE_DOCKER = `#!/bin/sh
if [ -n "$FAKE_DOCKER_CALL_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_DOCKER_CALL_LOG"; fi
case "$FAKE_DOCKER_SCENARIO" in
  stopped)
    if [ "$1" = "compose" ]; then printf 'kaoiro-c1\\n'
    else printf 'exited\\n'
    fi
    ;;
  wrong-status)
    if [ "$1" = "compose" ]; then printf 'kaoiro-c1\\n'
    else printf 'running\\n'
    fi
    ;;
  none)
    ;;
  multiple)
    if [ "$1" = "compose" ]; then printf 'kaoiro-c1\\nkaoiro-c2\\n'; fi
    ;;
esac
`;

let dir;
let bin;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kaoiro-deploy-branch-"));
  bin = join(dir, "fake-docker.sh");
  writeFileSync(bin, FAKE_DOCKER);
  chmodSync(bin, 0o700);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withScenario(scenario, fn) {
  const prior = process.env.FAKE_DOCKER_SCENARIO;
  process.env.FAKE_DOCKER_SCENARIO = scenario;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.FAKE_DOCKER_SCENARIO;
    else process.env.FAKE_DOCKER_SCENARIO = prior;
  }
}

test("classify returns branch A for one exited container", () => {
  const result = withScenario("stopped", () => classify(bin, dir, "kaoiro", false));
  assert.equal(result.branch, BRANCH.STOPPED_CONTAINER);
  assert.equal(result.container, "kaoiro-c1");
});

test("classify returns branch B when no container but prior state exists", () => {
  const result = withScenario("none", () => classify(bin, dir, "kaoiro", true));
  assert.equal(result.branch, BRANCH.STATE_WITHOUT_CONTAINER);
});

test("classify returns branch C when no container and no prior state", () => {
  const result = withScenario("none", () => classify(bin, dir, "kaoiro", false));
  assert.equal(result.branch, BRANCH.FRESH);
});

test("classify returns branch D for more than one matching container", () => {
  const result = withScenario("multiple", () => classify(bin, dir, "kaoiro", false));
  assert.equal(result.branch, BRANCH.DIAGNOSE);
});

test("classify returns branch D for a container in an unexpected status", () => {
  const result = withScenario("wrong-status", () => classify(bin, dir, "kaoiro", false));
  assert.equal(result.branch, BRANCH.DIAGNOSE);
});

for (const bound of [false, true]) {
  test(`Compose inputs: branch consumers preserve ${bound ? "bound" : "default"} arguments`, () => {
    const log = join(dir, "calls.log");
    const prior = process.env.FAKE_DOCKER_CALL_LOG;
    process.env.FAKE_DOCKER_CALL_LOG = log;
    const args = bound ? ["-f", join(dir, "compose.yaml"), "--project-directory", dir] : undefined;
    try {
      assert.equal(withScenario("stopped", () => classify(bin, dir, "kaoiro", false, args)).branch, BRANCH.STOPPED_CONTAINER);
      assert.equal(withScenario("wrong-status", () => requireRunningContainer(bin, dir, "kaoiro", args)), "kaoiro-c1");
    } finally {
      if (prior === undefined) delete process.env.FAKE_DOCKER_CALL_LOG; else process.env.FAKE_DOCKER_CALL_LOG = prior;
    }
    const compose = readFileSync(log, "utf8").trim().split("\n").filter(line => line.startsWith("compose "));
    const expected = ["compose", ...(args ?? []), "ps", "-a", "--format", "{{.Name}}", "kaoiro"].join(" ");
    assert.deepEqual(compose, [expected, expected]);
  });
}
