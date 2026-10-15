import type { DirectoryEntry, Envelope, Persona } from "./protocol";

function nonEmptyName(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Resolve live identity first, then the restart-surviving directory. The
 *  directory fallback is needed for durable history that names an agent no
 *  longer present in the live map. A live agent always has a concrete persona,
 *  including the `default` persona, so the fallback does not replace live
 *  identity. The "directory-only IA" case in
 *  `responseTimeline.integration.test.ts` pins this fallback. Do not "fix" or
 *  remove it as part of issue #234 work in App.svelte, AgentCard, or
 *  AgentDetail. Unknown or unresolved ids stay visible as their raw id. */
export function personaForAgent(
  agentId: string,
  agents: Record<string, Envelope>,
  directory?: Record<string, DirectoryEntry>,
): Persona | DirectoryEntry["persona"] | undefined {
  return agents[agentId]?.persona ?? directory?.[agentId]?.persona;
}

export function agentDisplayName(
  agentId: string,
  agents: Record<string, Envelope>,
  directory?: Record<string, DirectoryEntry>,
): string {
  const directoryName = directory?.[agentId]?.display_name;
  if (nonEmptyName(directoryName)) return directoryName;

  const live = agents[agentId];
  if (nonEmptyName(live?.display_name)) return live.display_name;
  if (nonEmptyName(live?.persona?.name)) return live.persona.name;

  const directoryPersonaName = directory?.[agentId]?.persona.name;
  if (nonEmptyName(directoryPersonaName)) return directoryPersonaName;

  return agentId;
}

export function projectDirectoryName(
  envelope: Envelope,
  directoryEntry: DirectoryEntry | undefined,
): Envelope {
  if (directoryEntry === undefined) return envelope;

  const directoryName = directoryEntry.display_name;
  const liveName = envelope.display_name;
  const displayName = nonEmptyName(directoryName)
    ? directoryName
    : nonEmptyName(liveName)
      ? liveName
      : undefined;

  if (displayName === undefined || displayName === envelope.display_name) return envelope;
  return { ...envelope, display_name: displayName };
}
