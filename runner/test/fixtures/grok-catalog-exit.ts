// Starts a Grok catalog probe, then aborts it and exits the process at
// once, as the runner's shutdown does (runner-cli.ts close, then exit).
// FAKE_EXECUTABLE is the probe's executable; FAKE_GROK_PIDS is written by
// the fake once it runs.
import { existsSync } from "node:fs";
import { GrokCatalog } from "../../src/grok-catalog.js";

const catalog = new GrokCatalog(undefined, { cwd: process.cwd(), executable: process.env.FAKE_EXECUTABLE!, env: process.env });
void catalog.refresh();
const timer = setInterval(() => {
  if (!existsSync(process.env.FAKE_GROK_PIDS!)) return;
  clearInterval(timer);
  catalog.abort();
  process.exit(0);
}, 20);
