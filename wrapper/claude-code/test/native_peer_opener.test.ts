import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchesPeerOpener, PEER_ROOT_PREFIX, PEER_ROOT_SUFFIX } from "../src/native_peer_opener.js";
import { recordedPeer } from "./fixtures/native_peer_opener.js";

const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));

describe("recorded native peer root and installed pin", () => {
  it("matches the independently recorded row bytes", () => {
    expect(PEER_ROOT_PREFIX + recordedPeer.hook + PEER_ROOT_SUFFIX).toBe(recordedPeer.row.message.content);
    expect(matchesPeerOpener(recordedPeer.row.message.content, recordedPeer.hook, recordedPeer.row.origin.from)).toBe(true);
  });
  it("requires review of the native framing on SDK updates", () => {
    const sdk = JSON.parse(readFileSync(join(dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
    expect(sdk.version).toBe("0.3.293");
  });
  // CI runs this artifact check on Linux x64; version and golden checks also run on other platforms.
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("pins the installed native formatter artifact", async () => {
    const binary = join(dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(binary)) hash.update(bytes);
    expect(hash.digest("hex")).toBe("8968405e26db478af44eabc4635ab5ca557057b702a54460a59c13e1b253e978");
  });
});
