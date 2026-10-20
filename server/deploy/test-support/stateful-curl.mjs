#!/usr/bin/env node
// Fake `curl` for the recovery property test: answers /api/health from the
// stateful docker model (the revision of the running service container),
// or as unhealthy for the revision the model marks as failing.
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(process.env.FAKE_DOCKER_STATE, "utf8"));
const running = state.containers.find((c) => c.service === "kaoiro" && c.status === "running");
if (!running) {
  process.stderr.write("curl: (7) Failed to connect\n");
  process.exit(7);
}
const revision = state.images[running.image]?.revision ?? "unknown";
const reported = revision === state.healthFailRevision ? "starting" : revision;
process.stdout.write(JSON.stringify({ build_revision: reported, build_dirty: false }));
