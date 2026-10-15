import { describe, expect, it } from "vitest";
import {
  agentDisplayName,
  personaForAgent,
  projectDirectoryName,
} from "../src/lib/personaName";
import { formatAgentLabel } from "../src/lib/protocol";
import type { DirectoryEntry, Envelope } from "../src/lib/protocol";

function liveAgent(state: string, displayName = "live-old"): Envelope {
  return {
    version: "0",
    agent_id: "live.agent",
    ts: "2026-09-23T00:00:00Z",
    type: "state_change",
    state,
    display_name: displayName,
    persona: { id: "momo", name: "live persona", sprite_set: "momo" },
  };
}

const directoryEntry: DirectoryEntry = {
  persona: { id: "ao", name: "directory persona", sprite_set: "ao" },
  display_name: "directory-new",
  last_seen: null,
};

describe("agentDisplayName (issue #666)", () => {
  it.each(["waiting_input", "disconnected"])(
    "prefers the newer directory name over a stale %s envelope",
    (state) => {
      expect(
        agentDisplayName(
          "live.agent",
          { "live.agent": liveAgent(state) },
          { "live.agent": directoryEntry },
        ),
      ).toBe("directory-new");
    },
  );

  it("uses a live display name when there is no directory label", () => {
    expect(agentDisplayName("live.agent", { "live.agent": liveAgent("idle", "live-new") })).toBe(
      "live-new",
    );
  });

  it("falls through empty names to live persona, directory persona, then id", () => {
    const live = liveAgent("idle", "");
    const emptyDirectory = { ...directoryEntry, display_name: "" };
    expect(agentDisplayName("live.agent", { "live.agent": live }, { "live.agent": emptyDirectory })).toBe(
      "live persona",
    );
    expect(
      agentDisplayName("offline.agent", {}, {
        "offline.agent": { ...directoryEntry, display_name: "" },
      }),
    ).toBe("directory persona");
    expect(
      agentDisplayName("unknown.agent", {}, {
        "unknown.agent": {
          persona: { id: "unknown.agent" },
          display_name: "",
          last_seen: null,
        },
      }),
    ).toBe("unknown.agent");
  });

  it("keeps live persona first for sprite resolution", () => {
    const live = liveAgent("idle");
    expect(personaForAgent("live.agent", { "live.agent": live }, { "live.agent": directoryEntry })).toBe(
      live.persona,
    );
  });

  it("preserves the name(id) header format and server's text-only label", () => {
    expect(
      formatAgentLabel(
        { "live.agent": liveAgent("idle") },
        "live.agent",
        { "live.agent": directoryEntry },
      ),
    ).toBe("directory-new(live.agent)");
    expect(formatAgentLabel({}, "server", { "server": directoryEntry })).toBe("server");
  });
});

describe("projectDirectoryName", () => {
  it("projects a directory name only when a directory entry exists", () => {
    const envelope = liveAgent("disconnected", "live-old");
    expect(projectDirectoryName(envelope, undefined)).toBe(envelope);
    expect(projectDirectoryName(envelope, directoryEntry)).toEqual({
      ...envelope,
      display_name: "directory-new",
    });
  });

  it("keeps the live name when the directory name is empty", () => {
    const envelope = liveAgent("disconnected", "live-current");
    expect(
      projectDirectoryName(envelope, { ...directoryEntry, display_name: "" }),
    ).toBe(envelope);
  });

  it("does not write persona names or ids when both display names are empty", () => {
    const envelope = liveAgent("disconnected", "");
    const projected = projectDirectoryName(envelope, {
      ...directoryEntry,
      display_name: "",
    });
    expect(projected).toBe(envelope);
    expect(projected.display_name).toBe("");
  });
});
