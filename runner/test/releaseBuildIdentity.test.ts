import { installChildFixture } from "../../scripts/test/fixtures/child-process-fixture.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactBuildIdentity, BUILD_REPOSITORY_ID, computeBuildIdentity, consumeBuildIdentity,
  readReleaseTag, readVersionTag, requireTaggedIdentity } from "../../scripts/build-identity.mjs";
import { planReleaseTag } from "../../scripts/release-tag.mjs";
import { loadBuildInfo } from "../src/build_info.js";

const root = resolve(import.meta.dirname, "../..");
let dir: string;
let repo: string;
let remote: string;
let revision: string;
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const day = "2026-10-22";

function releaseRecord(fields: Record<string, unknown> = {}) {
  return { schema: 2, kind: "release", repository_id: BUILD_REPOSITORY_ID, revision, branch: "develop", version: "2026.10.22.1", ...fields };
}
function release(fields: Record<string, unknown> = {}, { name, target = revision, message }: { name?: string; target?: string; message?: string } = {}) {
  const record = releaseRecord(fields);
  git(["-c", "tag.gpgSign=false", "tag", "-a", name ?? `v${String(record.version)}`, target, "--cleanup=verbatim", "-m", message ?? JSON.stringify(record)]);
  return record;
}
function landing() {
  const record = { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision, branch: "develop",
    version: "2026.10.09.1", original_run_id: 11, created_at: "2026-10-09T00:00:00Z" };
  git(["-c", "tag.gpgSign=false", "tag", "-a", "v2026.10.09.1", revision, "--cleanup=verbatim", "-m", JSON.stringify(record)]);
  git(["update-ref", `refs/tags/identity/landing/${revision}`, git(["rev-parse", "v2026.10.09.1"])]);
  return record;
}
function withOrigin() {
  git(["clone", "-q", "--bare", "--no-local", repo, remote], dir);
  git(["remote", "add", "origin", remote]);
}
function otherCommit(message: string) {
  return git(["commit-tree", "HEAD^{tree}", "-p", revision, "-m", message]);
}
const refs = (cwd: string) => git(["for-each-ref", "--format=%(objectname) %(refname)"], cwd);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kuroe709-release-reader-"));
  repo = join(dir, "source"); mkdirSync(repo);
  remote = join(dir, "origin.git");
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.name", "fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "source"), "first\n");
  git(["add", "source"]); git(["commit", "-qm", "first"]);
  revision = git(["rev-parse", "HEAD"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("schema-2 release tag reader", () => {
  it("reads an exact release tag as a tagged identity with its record", () => {
    const record = release();
    const identity = computeBuildIdentity(repo);
    expect(identity).toMatchObject({ version: "2026.10.22.1", branch: "develop", revision, dirty: false, degraded: false });
    expect(identity.release).toEqual(record);
    expect(identity.landing).toBeUndefined();
  });

  const armor = "\n-----BEGIN PGP SIGNATURE-----\n\niQEzBAABCAAdFiEE\n-----END PGP SIGNATURE-----\n";
  const refusals: Array<[string, () => void]> = [
    ["a lightweight tag", () => git(["tag", "v2026.10.22.1"])],
    ["a landing claim on the tag object", () => { release(); git(["update-ref", `refs/tags/identity/landing/${revision}`, git(["rev-parse", "v2026.10.22.1"])]); }],
    ["a landing claim on the commit", () => { release(); git(["update-ref", `refs/tags/identity/landing/${revision}`, revision]); }],
    ["a record naming another revision", () => release({ revision: "f".repeat(40) })],
    ["a tag name that differs from the record version", () => release({ version: "2026.10.22.8" }, { name: "v2026.10.22.7" })],
    ["a header tag line that differs from the ref and the record", () => {
      // Only the object's own `tag` header line disagrees: the record and the
      // ref name both say v2026.10.22.7.
      release({ version: "2026.10.22.7" }, { name: "v2026.10.22.8" });
      git(["update-ref", "refs/tags/v2026.10.22.7", git(["rev-parse", "refs/tags/v2026.10.22.8"])]);
      git(["update-ref", "-d", "refs/tags/v2026.10.22.8"]);
    }],
    ["an additional key", () => release({ released_at: "2026-10-22T00:00:00Z" })],
    ["a missing key", () => release({ repository_id: undefined })],
    ["schema 3", () => release({ schema: 3 })],
    ["schema 2 with kind landing", () => release({ kind: "landing" })],
    ["another repository", () => release({ repository_id: 1 })],
    ["a branch other than develop", () => release({ branch: "main" })],
    ["a landing pair and a release tag on one commit", () => { landing(); release(); }],
    ["a signature block after the record", () => release({}, { message: JSON.stringify(releaseRecord()) + armor })],
    ["an object over 4,096 bytes", () => release({}, { message: `{${" ".repeat(5000)}${JSON.stringify(releaseRecord()).slice(1)}` })],
    ["an object over 4,096 bytes only through whitespace after the record", () => release({}, { message: `${JSON.stringify(releaseRecord())}\n${" ".repeat(5000)}` })],
  ];
  it.each(refusals)("refuses %s", (_name, setup) => {
    setup();
    const identity = computeBuildIdentity(repo);
    expect(identity.version).toBe("untagged");
    expect(identity.degraded).toBe(true);
    expect(identity.release).toBeUndefined();
  });

  it("keeps the selection to v<YYYY.MM.DD>.* names, as for schema-1", () => {
    landing(); git(["tag", "v1.0.0"]); git(["tag", "v2026.9.0"]);
    expect(computeBuildIdentity(repo)).toMatchObject({ version: "2026.10.09.1", degraded: false });
    git(["tag", "-d", "v2026.10.09.1"]); git(["update-ref", "-d", `refs/tags/identity/landing/${revision}`]);
    release();
    expect(computeBuildIdentity(repo)).toMatchObject({ version: "2026.10.22.1", degraded: false });
  });

  it("negative control: a valid release tag on another commit leaves HEAD untagged and production refuses", () => {
    withOrigin();
    const other = otherCommit("other");
    release({ revision: other }, { target: other });
    git(["push", "-q", "origin", "--tags"]);
    expect(computeBuildIdentity(repo)).toMatchObject({ version: "untagged", degraded: false });
    expect(() => requireTaggedIdentity(repo, { target: revision, timeoutMs: 500 }))
      .toThrow(/completed exact landing tag\/claim or release tag/);
  });

  it("production refuses a pushed release tag whose raw object exceeds 4,096 bytes through trailing whitespace", () => {
    withOrigin();
    release({}, { message: `${JSON.stringify(releaseRecord())}\n${" ".repeat(5000)}` });
    expect(Number(git(["cat-file", "-s", "refs/tags/v2026.10.22.1"]))).toBeGreaterThan(4096);
    git(["push", "-q", "origin", "refs/tags/v2026.10.22.1"]);
    expect(() => requireTaggedIdentity(repo, { target: revision, timeoutMs: 500 })).toThrow(/production identity refused: invalid release tag object/);
  });

  it("refuses when the claim namespace cannot be read, and reads the tag when it can", () => {
    release();
    // Real Git for every read except the claim lookup, which fails as null.
    const realGit = (args: string[], cwd: string) => {
      try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; }
    };
    const failingClaim = (args: string[], cwd: string) => args[0] === "for-each-ref" ? null : realGit(args, cwd);
    expect(readVersionTag(repo, "v2026.10.22.1", BUILD_REPOSITORY_ID, { gitReader: realGit })).toMatchObject({ kind: "release" });
    expect(() => readVersionTag(repo, "v2026.10.22.1", BUILD_REPOSITORY_ID, { gitReader: failingClaim })).toThrow(/must not carry a landing claim/);
    expect(() => readReleaseTag(repo, "v2026.10.22.1", BUILD_REPOSITORY_ID, { gitReader: failingClaim })).toThrow(/must not carry a landing claim/);
  });

  it("production accepts a pushed release tag and refuses one that is local only", () => {
    withOrigin();
    release();
    expect(() => requireTaggedIdentity(repo, { target: revision, timeoutMs: 500 })).toThrow(/differs from origin/);
    git(["push", "-q", "origin", "refs/tags/v2026.10.22.1"]);
    expect(requireTaggedIdentity(repo, { target: revision, timeoutMs: 500 })).toMatchObject({ version: "2026.10.22.1", release: { revision } });
  });

  it("production re-reads the release tag and refuses a claim that appears on origin after the inventory", () => {
    withOrigin();
    release(); git(["push", "-q", "origin", "refs/tags/v2026.10.22.1"]);
    const shim = join(dir, "bin"); mkdirSync(shim);
    writeFileSync(join(shim, "git"), `#!${process.execPath}\n
      const {spawnSync}=require('node:child_process');
      const args=process.argv.slice(2);
      const observed=spawnSync('/usr/bin/git',args,{encoding:'utf8'});
      if(args.join(' ')==='ls-remote --tags --refs origin') {
        const moved=spawnSync('/usr/bin/git',['--git-dir',${JSON.stringify(remote)},'update-ref','refs/tags/identity/landing/${revision}','${revision}'],{encoding:'utf8'});
        if(moved.status!==0) process.exit(99);
      }
      process.stdout.write(observed.stdout);process.stderr.write(observed.stderr);process.exit(observed.status??98);
    `, { mode: 0o755 });
    const previousPath = process.env.PATH;
    const restore = installChildFixture(shim);
    try {
      process.env.PATH = `${shim}:${previousPath}`;
      expect(() => requireTaggedIdentity(repo, { target: revision, timeoutMs: 500 }))
        .toThrow(/selected release tag differs from origin read-back or carries a landing claim/);
    } finally { restore(); process.env.PATH = previousPath; }
    expect(git(["rev-parse", `refs/tags/identity/landing/${revision}`], remote)).toBe(revision);
  });
});

describe("frozen release identity", () => {
  const frozen = () => artifactBuildIdentity(computeBuildIdentity(repo), "2026-10-22T00:00:00.000Z");
  const consume = (value: unknown) => consumeBuildIdentity(repo, { KAOIRO_BUILD_IDENTITY_JSON: JSON.stringify(value) });

  it("carries the release record and no landing record", () => {
    const record = release();
    const identity = frozen();
    expect(identity.release).toEqual(record);
    expect(Object.hasOwn(identity, "landing")).toBe(false);
    expect(consume(identity)).toEqual(identity);
  });
  it("refuses both records, neither record and a record that disagrees", () => {
    release();
    const identity = frozen();
    const landingRecord = { schema: 1, kind: "landing", repository_id: BUILD_REPOSITORY_ID, revision, branch: "develop",
      version: "2026.10.22.1", original_run_id: 1, created_at: "2026-10-22T00:00:00Z" };
    expect(() => consume({ ...identity, landing: landingRecord })).toThrow(/exactly one landing or release record/);
    const { release: _record, ...neither } = identity;
    expect(() => consume(neither)).toThrow(/exactly one landing or release record/);
    expect(() => consume({ ...identity, version: "2026.10.22.2" })).toThrow(/disagrees with its record/);
    expect(() => consume({ ...identity, release: { ...identity.release, extra: true } })).toThrow(/malformed release annotation/);
  });
  it("the runner's build-info reader keeps a release build's identity (no new reader capability)", () => {
    release();
    const target = join(dir, "dist"); mkdirSync(target);
    writeFileSync(join(target, "build-info.json"), JSON.stringify(frozen()));
    expect(loadBuildInfo(target)).toMatchObject({ revision, version: "2026.10.22.1", branch: "develop" });
    expect(frozen().build_identity_formats).toEqual(["legacy-calver", "landing-calver-v1"]);
  });
});

describe("release-tag.mjs plan", () => {
  it("numbers after the highest origin tag of the day and ignores malformed numbers", () => {
    withOrigin();
    for (const [n, message] of [["1", "a"], ["2", "b"], ["10", "c"]] as const) {
      const other = otherCommit(message);
      release({ revision: other, version: `2026.10.22.${n}` }, { target: other });
    }
    git(["tag", "v2026.10.22.01", otherCommit("d")]);
    git(["tag", "v2026.10.21.50", otherCommit("e")]);
    git(["push", "-q", "origin", "--tags"]);
    const plan = planReleaseTag(repo, { day });
    expect(plan.name).toBe("v2026.10.22.11");
    expect(plan.record).toEqual(releaseRecord({ version: "2026.10.22.11" }));
  });
  it.each([
    ["a dirty checkout", () => writeFileSync(join(repo, "untracked"), "x\n"), /dirty/],
    ["a local release tag", () => release(), /already tagged as v2026\.10\.22\.1/],
    ["a local lightweight calver tag", () => git(["tag", "v2026.10.20.3"]), /already tagged as v2026\.10\.20\.3/],
    ["a local landing claim", () => git(["update-ref", `refs/tags/identity/landing/${revision}`, revision]), /landing claim exists for/],
    ["a local landing claim that points at another commit", () => git(["update-ref", `refs/tags/identity/landing/${revision}`, otherCommit("claim target")]), /landing claim exists for/],
    ["a release tag on origin only", () => { release(); git(["push", "-q", "origin", "--tags"]); git(["tag", "-d", "v2026.10.22.1"]); }, /already tagged on origin as v2026\.10\.22\.1/],
    ["a landing claim on origin only", () => { git(["update-ref", `refs/tags/identity/landing/${revision}`, revision]); git(["push", "-q", "origin", "--tags"]); git(["update-ref", "-d", `refs/tags/identity/landing/${revision}`]); }, /landing claim exists on origin/],
    ["a revision that is not a full commit id", () => undefined, /full 40-hex commit/],
  ] as Array<[string, () => void, RegExp]>)("refuses %s", (name, setup, message) => {
    withOrigin();
    setup();
    const options = name.startsWith("a revision") ? { day, revision: "--upload-pack=x" } : { day };
    expect(() => planReleaseTag(repo, options)).toThrow(message);
  });
  it("plans a tag when no claim exists, and the same checkout refuses once a claim names the revision", () => {
    withOrigin();
    expect(planReleaseTag(repo, { day }).name).toBe("v2026.10.22.1");
    git(["update-ref", `refs/tags/identity/landing/${revision}`, otherCommit("claim target")]);
    expect(() => planReleaseTag(repo, { day })).toThrow(/landing claim exists for/);
  });
  it("creates, pushes and fetches nothing", () => {
    withOrigin();
    const before = [refs(repo), refs(remote)];
    planReleaseTag(repo, { day });
    expect([refs(repo), refs(remote)]).toEqual(before);
    expect(existsSync(join(repo, ".git/FETCH_HEAD"))).toBe(false);
  });
});

describe("release tag real entry", () => {
  function project() {
    const source = join(dir, "project"); mkdirSync(join(source, "scripts"), { recursive: true });
    for (const name of ["build-identity.mjs", "with-build-identity.mjs", "release-tag.mjs", "child-process-environment.mjs"])
      cpSync(join(root, "scripts", name), join(source, "scripts", name));
    cpSync(join(root, "scripts/build-runner-tarball.sh"), join(source, "scripts/build-runner-tarball.sh"));
    mkdirSync(join(source, "runner/deploy"), { recursive: true });
    cpSync(join(root, "runner/deploy/child-process-environment.mjs"), join(source, "runner/deploy/child-process-environment.mjs"));
    git(["init", "-q", "-b", "develop"], source);
    git(["config", "user.name", "Test"], source);
    git(["config", "user.email", "t@example.com"], source);
    git(["config", "tag.gpgSign", "false"], source);
    git(["add", "."], source);
    git(["commit", "-qm", "fixture"], source);
    const origin = join(dir, "project.git");
    git(["clone", "-q", "--bare", "--no-local", source, origin], dir);
    git(["remote", "add", "origin", origin], source);
    return source;
  }
  // Runs the helper's two printed commands exactly as printed.
  function releaseWithHelper(source: string) {
    const planned = spawnSync(process.execPath, [join(source, "scripts/release-tag.mjs"), "plan", "--day", day], { cwd: source, encoding: "utf8" });
    expect(planned.status, planned.stderr).toBe(0);
    const commands = planned.stdout.split("\n").filter((line) => line.startsWith("git "));
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      const ran = spawnSync("sh", ["-c", command], { cwd: source, encoding: "utf8" });
      expect(ran.status, ran.stderr).toBe(0);
    }
    return planned;
  }
  function tarball(source: string) {
    const bin = join(dir, "fake-bin"); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    return spawnSync("bash", [join(source, "scripts/build-runner-tarball.sh"), "--require-tagged"],
      { cwd: source, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir } });
  }
  const build = (source: string) => spawnSync(process.execPath, [join(source, "scripts/with-build-identity.mjs"), "--require-tagged", "--",
    process.execPath, "-e", "process.stdout.write(process.env.KAOIRO_BUILD_IDENTITY_JSON)"], { cwd: source, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } });

  it("the helper's printed commands produce a tag that the coordinated build accepts", () => {
    const source = project();
    const head = git(["rev-parse", "HEAD"], source);
    const planned = releaseWithHelper(source);
    expect(planned.stdout).toContain("Not approved before cutover C");
    const result = build(source);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: "2026.10.22.1", revision: head, release: { revision: head, version: "2026.10.22.1" } });
  });
  it("the coordinated build refuses a lightweight calver tag", () => {
    const source = project();
    git(["tag", "v2026.10.22.1"], source);
    git(["push", "-q", "origin", "--tags"], source);
    const result = build(source);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("production identity refused: version tag must be annotated");
  });
  it("the tarball builder passes its tagged gate for a release tag", () => {
    const source = project();
    releaseWithHelper(source);
    const result = tarball(source);
    expect(result.stdout).toContain("build-runner-tarball: building TypeScript");
    expect(result.status).toBe(97);
  });
  it("the tarball builder refuses a lightweight calver tag before building", () => {
    const source = project();
    git(["tag", "v2026.10.22.1"], source);
    git(["push", "-q", "origin", "--tags"], source);
    const result = tarball(source);
    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("building TypeScript");
  });
});
