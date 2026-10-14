// PreToolUse policy for the live tests (issue 615). Asks the client for the
// calls a test expects and denies everything else, whatever the host's own
// permission settings. A deny does not end the turn; the model is told why.
// KAOIRO_TEST_GROK_ASK_MARKER: a substring the terminal command must contain.
// KAOIRO_TEST_GROK_ASK_TOOLS: comma-separated kaoiro tool names.
import { readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(0, "utf8"));
const marker = process.env.KAOIRO_TEST_GROK_ASK_MARKER ?? "";
const tools = (process.env.KAOIRO_TEST_GROK_ASK_TOOLS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const name = String(event.tool_name ?? "");
const command = event.tool_input?.command;
const ask =
  (marker !== "" &&
    name === "run_terminal_command" &&
    typeof command === "string" &&
    command.includes(marker)) ||
  tools.includes(name.replace(/^kaoiro__/, ""));
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: ask ? "ask" : "deny",
      permissionDecisionReason: ask
        ? "kaoiro live test"
        : "Only the tool calls this test requested may run.",
    },
  }),
);
