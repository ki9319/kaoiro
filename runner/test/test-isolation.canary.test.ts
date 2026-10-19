import { it } from "vitest";
import {
  assertIsolationActive,
} from "../../scripts/test/fixtures/test-isolation-canary.mjs";

// docs/contributing/test-isolation.md: red when this package's setup stops
// loading the isolation module.
it("runs under the test isolation guard", async () => {
  await assertIsolationActive();
});
