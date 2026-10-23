import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { expectWhoamiDirectoryName, expectWhoamiDirectoryNameUnavailable } from "./whoami_contract.js";

const persona = { id: "p", name: "P", sprite_set: "p" };

describe.each(["claude-code", "codex", "antigravity", "grok"])("%s whoami assertion diagnostics", (engine) => {
  it.each(["initial", "renamed"])("identifies the directory-name invariant and %s phase", (phase) => {
    expect(() => expectWhoamiDirectoryName(
      { display_name: "stale", persona }, "current", persona, `${engine}/${phase}`,
    )).toThrowError(`${engine}/${phase}: whoami.directory-name`);
  });

  it("identifies the omission invariant and unavailable phase", () => {
    expect(() => expectWhoamiDirectoryNameUnavailable(
      { display_name: "stale", persona }, `${engine}/unavailable`,
    )).toThrowError(`${engine}/unavailable: whoami.directory-name-unavailable`);
  });
});
