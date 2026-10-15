export const AGENT_MARKER_ENV = Object.freeze({ KAOIRO_AGENT: "1" } as const);

export function withAgentMarker(
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...AGENT_MARKER_ENV,
  };
}
