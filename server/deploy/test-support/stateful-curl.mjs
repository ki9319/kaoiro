#!/usr/bin/env node
// Fake `curl` for the recovery property test: answers /api/health from the
// stateful docker model (the revision of the running service container),
// or as unhealthy for the revision the model marks as failing.
import { readFileSync } from "node:fs";

const statePath = readFileSync(process.argv[1] + ".state", "utf8");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const running = state.containers.find((c) => c.service === "kaoiro" && c.status === "running");
if (!running) {
  process.stderr.write("curl: (7) Failed to connect\n");
  process.exit(7);
}
const revision = state.images[running.image]?.revision ?? "unknown";
const reported = revision === state.healthFailRevision ? "starting" : revision;
process.stdout.write(JSON.stringify({ build_revision: reported, build_dirty: false }));
