import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

// Grok state a live test leaves behind, and who may remove it. Grok keeps a
// session group per cwd and a memory workspace named after the cwd basename
// (leading dots dropped, lowercased) plus `-<8 hex>` (measured on 1.0.52),
// both in a home it shares with every other test and peer on the host. So
// removal is limited to what this process proves it made: a cwd it created,
// and a workspace that appeared after that and carries the cwd's name. The
// runner keeps a copy of this file; keep the two identical.

interface Scratch {
  home: string;
  before: Set<string>;
}

const scratches = new Map<string, Scratch>();
const grokHome = () => process.env.GROK_HOME ?? join(homedir(), ".grok");
const workspaces = (home: string) => {
  const dir = join(home, "memory-v2", "workspaces");
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** Makes a scratch cwd for a live test, named `.kaoiro-grok-<purpose>-XXXXXX`
 *  under the home or tmp directory, and records it as this process's own.
 *  A read-only launch refuses a cwd under tmp, hence the home default. */
export function makeGrokScratch(purpose: string, parent: "home" | "tmp" = "home"): string {
  if (!/^[a-z]+(-[a-z]+)*$/.test(purpose)) throw new Error(`bad scratch purpose: ${purpose}`);
  const home = grokHome();
  const before = new Set(workspaces(home));
  const cwd = mkdtempSync(join(parent === "home" ? homedir() : tmpdir(), `.kaoiro-grok-${purpose}-`));
  scratches.set(cwd, { home, before });
  return cwd;
}

/** Removes the Grok state of a cwd made by makeGrokScratch: its session group
 *  and the one workspace that appeared for it. Any other cwd removes nothing,
 *  and so does a workspace whose owner is ambiguous. */
export function removeGrokState(cwd: string): void {
  const scratch = scratches.get(cwd);
  if (!scratch) return;
  scratches.delete(cwd);
  rmSync(join(scratch.home, "sessions", encodeURIComponent(cwd)), { recursive: true, force: true });
  const name = new RegExp(`^${basename(cwd).slice(1).toLowerCase()}-[0-9a-f]{8}$`);
  const appeared = workspaces(scratch.home).filter((entry) => !scratch.before.has(entry) && name.test(entry));
  if (appeared.length !== 1) return;
  rmSync(join(scratch.home, "memory-v2", "workspaces", appeared[0]!), { recursive: true, force: true });
}
