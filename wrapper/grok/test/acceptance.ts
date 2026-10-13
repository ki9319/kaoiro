import assert from "node:assert/strict";
export interface ToolEvidence {
  calls: { name: string; input: Record<string, unknown>; isError: boolean }[];
  text: string;
}
export function checkToolRoundTrip(
  evidence: ToolEvidence,
  name: string,
  input: Record<string, unknown>,
  marker: string,
) {
  assert(
    evidence.calls.some(
      (call) =>
        call.name === name &&
        !call.isError &&
        JSON.stringify(call.input) === JSON.stringify(input),
    ),
    "tool call/arguments/result missing",
  );
  assert(evidence.text.includes(marker), "tool result did not reach the model");
}
