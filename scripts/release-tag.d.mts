// Type declaration for release-tag.mjs, for runner's typed test suite.
import type { ReleaseRecord } from "./build-identity.mjs";

export function planReleaseTag(cwd?: string, options?: { revision?: string; day?: string }):
  { name: string; record: ReleaseRecord; commands: string[] };
