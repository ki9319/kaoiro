import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGrokScratch, removeGrokState } from "./grok-state.js";

// The cleanup of live-test Grok state, against a fake GROK_HOME only. The
// runner keeps a copy of this file; keep the two identical.

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
  it("removes its own scratch cwd and that cwd's session group only", () => {
    const cwd = scratch("state");
    mkdirSync(session(cwd), { recursive: true });
    mkdirSync(session(`${cwd}x`), { recursive: true });
    removeGrokState(cwd);
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(join(home, "sessions"))).toEqual([encodeURIComponent(`${cwd}x`)]);
  });

  it("leaves every memory workspace, its own name's included", () => {
    const cwd = scratch("state");
    // Whether Grok made these for this cwd or for another with the same
    // basename, nothing proves which; all of them stay.
    const named = [workspaceOf(cwd, "0123abcd"), workspaceOf(cwd, "fedcba98")];
    for (const entry of named) mkdirSync(ws(entry), { recursive: true });
    removeGrokState(cwd);
    expect(readdirSync(ws()).sort()).toEqual([...named, "work-0123abcd"].sort());
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
    mkdirSync(session(cwd), { recursive: true });
    removeGrokState(cwd);
    expect(existsSync(session(cwd))).toBe(true);
  });
});

describe("makeGrokScratch", () => {
  it("refuses a purpose that could change the path", () => {
    for (const purpose of ["", "../x", "a/b", "A", "a-"]) expect(() => makeGrokScratch(purpose, "tmp")).toThrow();
  });
});
