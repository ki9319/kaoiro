// ES module entry for test files and Vitest setup files. The implementation is
// CommonJS (test-isolation.cjs) so that child processes can preload it with
// --require; see docs/contributing/test-isolation.md.
import { createRequire } from "node:module";

const isolation = createRequire(import.meta.url)("./test-isolation.cjs");
// Vitest evaluates this again for each test file in a reused worker.
isolation.beginEntry();

export const {
  boundaryEnvironment, isolationNodeOptions, permitHostAccess, registerForeignRoot, registerOwnedRoot,
} = isolation;
