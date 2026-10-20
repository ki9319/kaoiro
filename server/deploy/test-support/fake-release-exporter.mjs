#!/usr/bin/env node
// Fake release exporter for the recovery property test: answers `audit` as
// an enrolled pass and echoes the release context it was given, so the
// deploy CLI's own checks (auditServerRelease, assertServerResumeContext,
// bindServerReleaseAudit) decide. It runs with an empty environment
// (the "authority" child profile), so it reads everything from argv and the
// descriptor next to --install-root.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
if (args[0] !== "audit") {
  process.stderr.write(`fake exporter: unsupported ${args[0]}\n`);
  process.exit(2);
}
const installRoot = flag("install-root");
const descriptor = JSON.parse(readFileSync(join(installRoot, ".kaoiro-release-authority.json"), "utf8"));
const attempt = flag("release-attempt");
process.stdout.write(JSON.stringify({
  schema: 1,
  status: "enrolled",
  pass: true,
  role: "server",
  authority_sha256: flag("expected-authority-sha256"),
  root: installRoot,
  canonical_root: descriptor.root,
  release_context: attempt === undefined ? null : { attempt_uuid: attempt, plan_sha256: flag("release-plan-sha256") },
}));
