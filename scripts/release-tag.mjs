#!/usr/bin/env node
// Plans the next schema-2 release tag. Reads only: it never creates a tag,
// pushes or fetches (docs/plans/issue-709-release-reduction.md section 3.3).
import { execChildSync } from "./child-process-environment.mjs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILD_REPOSITORY_ID, formatLandingVersion, validateReleaseRecord } from "./build-identity.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA = /^[0-9a-f]{40}$/;
const CALVER_TAG = /^v\d{4}\.\d{2}\.\d{2}\./;

function git(args, cwd) {
  return execChildSync("git", "git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();
}

function refuse(message) {
  throw new Error(`release tag refused: ${message}`);
}

/** Returns `{ name, record, commands }` for the next release tag of `revision`
 *  on `day` (UTC `YYYY-MM-DD`), or throws when the revision cannot be released
 *  under a new tag. */
export function planReleaseTag(cwd = repoRoot, { revision, day = new Date().toISOString().slice(0, 10) } = {}) {
  if (git(["status", "--porcelain"], cwd) !== "") refuse("the checkout is dirty");
  const head = git(["rev-parse", "HEAD"], cwd);
  const target = revision ?? head;
  if (!SHA.test(target) || git(["rev-parse", "--verify", `${target}^{commit}`], cwd) !== target) {
    refuse("revision must be a full 40-hex commit in this checkout");
  }
  // `git tag --points-at` lists a landing claim as `identity/landing/<revision>`
  // whether the claim points at a tag object or at the commit.
  const local = git(["tag", "--points-at", target], cwd).split("\n").filter(Boolean);
  if (local.includes(`identity/landing/${target}`)) refuse(`a landing claim exists for ${target}`);
  const localTag = local.find((name) => CALVER_TAG.test(name));
  if (localTag) refuse(`already tagged as ${localTag}`);

  const remote = git(["ls-remote", "--tags", "origin"], cwd).split("\n").filter(Boolean).map((row) => {
    const [object, ref] = row.split("\t");
    if (!SHA.test(object) || !ref?.startsWith("refs/tags/")) refuse("cannot read the origin tag inventory");
    return { object, ref: ref.slice("refs/tags/".length) };
  });
  if (remote.some(({ ref }) => ref === `identity/landing/${target}`)) refuse(`a landing claim exists on origin for ${target}`);
  const remoteTag = remote.find(({ object, ref }) => object === target && CALVER_TAG.test(ref.replace(/\^\{\}$/, "")));
  if (remoteTag) refuse(`already tagged on origin as ${remoteTag.ref.replace(/\^\{\}$/, "")}`);

  const prefix = `v${formatLandingVersion(day, 1).slice(0, -2)}.`;
  const used = remote.map(({ ref }) => ref).filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length)).filter((n) => /^[1-9][0-9]{0,5}$/.test(n)).map(Number);
  const version = formatLandingVersion(day, Math.max(0, ...used) + 1);
  const record = validateReleaseRecord({ schema: 2, kind: "release", repository_id: BUILD_REPOSITORY_ID,
    revision: target, branch: "develop", version });
  const name = `v${version}`;
  return { name, record, commands: [
    `git tag -a -m '${JSON.stringify(record)}' ${name} ${target}`,
    `git push origin refs/tags/${name}`,
  ] };
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action !== "plan") throw new Error("usage: release-tag.mjs plan [--revision <40-hex>] [--day YYYY-MM-DD] [--repo <dir>]");
  let cwd = repoRoot;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (!["--revision", "--day", "--repo"].includes(args[i])) throw new Error(`unsupported option: ${args[i]}`);
    if (!value || value.startsWith("-")) throw new Error(`${args[i]} requires a value`);
    if (args[i] === "--repo") cwd = value;
    else if (args[i] === "--revision") options.revision = value;
    else options.day = value;
    i++;
  }
  const plan = planReleaseTag(cwd, options);
  process.stdout.write([
    `tag: ${plan.name}`,
    `record: ${JSON.stringify(plan.record)}`,
    "Not approved before cutover C (docs/plans/issue-709-release-reduction.md section 3.7).",
    "Commands for the release operator:",
    ...plan.commands,
    "",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`release-tag: ${error.message}\n`);
    process.exitCode = 78;
  }
}
