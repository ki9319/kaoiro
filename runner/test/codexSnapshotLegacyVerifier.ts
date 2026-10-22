import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Preserve the f84297a5 reader in this fixture: a rollback must still verify snapshots written after N1.
export async function verifySnapshotFromF84297a5(path: string, expectedHash: string, snapshotModule: string) {
  const { digest, identity, inventory, must, sameState } = await import(snapshotModule);
  identity(path);
  const bytes = readFileSync(join(path, "manifest.json"));
  must(digest(bytes) === expectedHash, "Snapshot manifest digest mismatch");
  const manifest = JSON.parse(bytes.toString("utf8"));
  must(manifest.schema === 1 && manifest.classification === 1 && Array.isArray(manifest.entries), "Unsupported snapshot manifest");
  must(JSON.stringify(readdirSync(path).sort()) === JSON.stringify(["manifest.json", "state"]), "Unexpected snapshot entry");
  const actual = inventory(join(path, "state"), true) as Array<{ category: string }>;
  must(actual.every((e) => e.category === "state"), "Snapshot contains excluded entries");
  must(sameState(actual, manifest.entries), "Snapshot payload mismatch");
  return manifest;
}
