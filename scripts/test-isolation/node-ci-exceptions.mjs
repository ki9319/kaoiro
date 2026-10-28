export const NODE_CI_EXCEPTIONS = [
  { path: "scripts/test/pre-gate-real.test.mjs", issue: 872, reason: "pnpm workers are refused by the isolation guard" },
];
