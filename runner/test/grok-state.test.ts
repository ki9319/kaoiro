import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGrokScratch, removeGrokState } from "./grok-state.js";

// The cleanup of live-test Grok state, against a fake GROK_HOME only. The
// runner keeps a copy of this file; keep the two identical.

// Lets a test know a scratch cwd's name before it exists; every other
// mkdtemp stays random.
const next = vi.hoisted(() => ({ suffix: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (prefix: string) => {
      const suffix = next.suffix;
      if (suffix === undefined) return fs.mkdtempSync(prefix);
      next.suffix = undefined;
      fs.mkdirSync(`${prefix}${suffix}`);
      return `${prefix}${suffix}`;
    },
  };
});

let home: string;
let previous: string | undefined;
const made: string[] = [];
const ws = (...entries: string[]) => join(home, "memory-v2", "workspaces", ...entries);
const session = (cwd: string) => join(home, "sessions", encodeURIComponent(cwd));
const workspaceOf = (cwd: string, hash: string) => `${basename(cwd).slice(1).toLowerCase()}-${hash}`;
const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .map((entry) => relative(dir, join(entry.parentPath, entry.name))).sort();
const scratch = (purpose: string) => {
  const cwd = makeGrokScratch(purpose, "tmp");
  made.push(cwd);
  return cwd;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kaoiro-grok-fake-home-"));
  previous = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  mkdirSync(ws("work-0123abcd"), { recursive: true });
  writeFileSync(join(home, "marker"), "");
});

afterEach(() => {
  if (previous === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previous;
  rmSync(home, { recursive: true, force: true });
  for (const cwd of made.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("removeGrokState", () => {
  it("removes the session group and the workspace that appeared for its own scratch cwd", () => {
    const cwd = scratch("state");
    mkdirSync(ws(workspaceOf(cwd, "0123abcd")), { recursive: true });
    mkdirSync(session(cwd), { recursive: true });
    mkdirSync(session(`${cwd}x`), { recursive: true });
    mkdirSync(ws(`${workspaceOf(cwd, "0123abcd")}-more`), { recursive: true });
    removeGrokState(cwd);
    expect(readdirSync(ws()).sort()).toEqual([`${workspaceOf(cwd, "0123abcd")}-more`, "work-0123abcd"]);
    expect(readdirSync(join(home, "sessions"))).toEqual([encodeURIComponent(`${cwd}x`)]);
  });

  it("keeps a workspace with the same name that existed before the cwd was made", () => {
    const suffix = `Q${Math.random().toString(36).slice(2, 7)}`;
    const name = `kaoiro-grok-state-${suffix.toLowerCase()}`;
    // Another cwd with the same basename, made before this one.
    mkdirSync(ws(`${name}-11111111`), { recursive: true });
    next.suffix = suffix;
    const cwd = scratch("state");
    expect(basename(cwd)).toBe(`.kaoiro-grok-state-${suffix}`);
    mkdirSync(ws(`${name}-22222222`), { recursive: true });
    removeGrokState(cwd);
    expect(readdirSync(ws()).sort()).toEqual([`${name}-11111111`, "work-0123abcd"]);
  });

  it("removes no workspace when two appeared under its name", () => {
    const cwd = scratch("state");
    mkdirSync(ws(workspaceOf(cwd, "11111111")), { recursive: true });
    mkdirSync(ws(workspaceOf(cwd, "22222222")), { recursive: true });
    mkdirSync(session(cwd), { recursive: true });
    removeGrokState(cwd);
    expect(readdirSync(ws()).sort())
      .toEqual([workspaceOf(cwd, "11111111"), workspaceOf(cwd, "22222222"), "work-0123abcd"]);
    expect(readdirSync(join(home, "sessions"))).toEqual([]);
  });

  it.each([
    ["the parent directory", ".."],
    ["a relative path", ".kaoiro-grok-state-AbC123"],
    ["a path outside the scratch parents", "/first/.kaoiro-grok-state-AbC123"],
    ["a well-formed path it did not make", join(homedir(), ".kaoiro-grok-state-AbC123")],
    ["a path without the scratch prefix", join(homedir(), ".work")],
  ])("removes nothing for %s", (_label, cwd) => {
    mkdirSync(ws(`${basename(cwd).slice(1).toLowerCase()}-0123abcd`), { recursive: true });
    mkdirSync(join(home, "sessions"), { recursive: true });
    mkdirSync(session(cwd), { recursive: true });
    const before = tree(home);
    removeGrokState(cwd);
    expect(tree(home)).toEqual(before);
  });

  it("removes nothing a second time", () => {
    const cwd = scratch("state");
    removeGrokState(cwd);
    mkdirSync(ws(workspaceOf(cwd, "0123abcd")), { recursive: true });
    removeGrokState(cwd);
    expect(readdirSync(ws())).toContain(workspaceOf(cwd, "0123abcd"));
  });
});

describe("makeGrokScratch", () => {
  it("refuses a purpose that could change the path", () => {
    for (const purpose of ["", "../x", "a/b", "A", "a-"]) expect(() => makeGrokScratch(purpose, "tmp")).toThrow();
  });
});
