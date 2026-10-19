// @vitest-environment jsdom
import { it } from "vitest";
import {
  assertIsolationActive,
} from "../../scripts/test/fixtures/test-isolation-canary.mjs";

// Module scope as well: scripts/test-isolation/check.mjs lists this package's
// suite with `vitest list`, which collects files without running tests.
await assertIsolationActive();

// Most dashboard tests run under jsdom; the setup must load there as well.
it("runs under the test isolation guard in jsdom files", async () => {
  await assertIsolationActive();
});
