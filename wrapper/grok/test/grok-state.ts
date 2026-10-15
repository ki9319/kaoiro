import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Grok state a live test leaves behind, and who may remove it. Grok keeps a
// session group per cwd, under the URI-encoded cwd, in a home it shares with
// every other test and peer on the host. Removal is limited to what this
// process proves it made: a cwd it created and that cwd's session group.
// Grok also names a memory workspace after the cwd basename plus a hash, but
// nothing here ties that hash to a full cwd, so workspaces are never removed
// (issue #650 tracks their buildup). The runner keeps a copy of this file;
// keep the two identical.

const scratches = new Map<string, string>();

/** Makes a scratch cwd for a live test, named `.kaoiro-grok-<purpose>-XXXXXX`
 *  under the home or tmp directory, and records it as this process's own.
 *  A read-only launch refuses a cwd under tmp, hence the home default. */
export function makeGrokScratch(purpose: string, parent: "home" | "tmp" = "home"): string {
  if (!/^[a-z]+(-[a-z]+)*$/.test(purpose)) throw new Error(`bad scratch purpose: ${purpose}`);
  const home = process.env.GROK_HOME ?? join(homedir(), ".grok");
  const cwd = mkdtempSync(join(parent === "home" ? homedir() : tmpdir(), `.kaoiro-grok-${purpose}-`));
  scratches.set(cwd, home);
  return cwd;
}

/** Removes a cwd made by makeGrokScratch and its Grok session group. Any
 *  other cwd removes nothing; no memory workspace is ever removed. */
export function removeGrokState(cwd: string): void {
  const home = scratches.get(cwd);
  if (home === undefined) return;
  scratches.delete(cwd);
  rmSync(join(home, "sessions", encodeURIComponent(cwd)), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
