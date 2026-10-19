// Vitest cannot load a setup file outside this separate root in jsdom files,
// so the shared isolation module is imported from inside the root.
import "../../scripts/test/fixtures/test-isolation.mjs";
