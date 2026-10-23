import "../../scripts/test/fixtures/test-isolation.mjs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareSelections, loadTiers, TIERS } from "../scripts/tier-selection.mjs";

// What Vitest actually selects for each KAOIRO_RUNNER_TIER value, compared with
// runner/test-tiers.json. A declared file that a selection omits (for example a
// name Vitest excludes by default) or an undeclared file that integration or
// native selects fails here by name. It starts Vitest, so it is an integration test.
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..");

function selected(tier: string): string[] {
  const out = execFileSync(join(RUNNER, "node_modules/.bin/vitest"), ["list", "--json", "--filesOnly"], {
    cwd: RUNNER, encoding: "utf8", env: { ...process.env, KAOIRO_RUNNER_TIER: tier }, maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(out) as { file: string }[]).map(row => relative(RUNNER, row.file).split("\\").join("/"));
}

describe("runner test tiers", () => {
  it("select what runner/test-tiers.json declares, and the tiers partition the complete selection", () => {
    expect(TIERS).toEqual(["complete", "fast", "integration", "native"]);
    const [complete, fast, integration, native] = TIERS.map(selected);
    expect(compareSelections({ complete, fast, integration, native, declared: loadTiers(RUNNER) } as never)).toEqual([]);
  }, 120_000);
});
