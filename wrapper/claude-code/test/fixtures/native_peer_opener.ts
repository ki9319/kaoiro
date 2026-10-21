import { readFileSync } from "node:fs";

// Recorded SDK 0.3.306 / CLI 2.1.306 row and hook; identities, timestamp, working directory and report marker were redacted.
export const recordedPeer = JSON.parse(readFileSync(new URL("./native-peer-opener-2.1.306.json", import.meta.url), "utf8")) as {
  hook: string;
  row: { uuid: string; promptId: string; origin: { kind: string; from: string; senderTaskId: string; body: string; handback: boolean };
    message: { role: string; content: string }; [key: string]: unknown };
};

export function peerFixture(body = recordedPeer.row.origin.body, from = "task") {
  const escaped = from.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const hook = recordedPeer.hook.replace('from="task"', `from="${escaped}"`).replace(recordedPeer.row.origin.body, body);
  const row = structuredClone(recordedPeer.row);
  row.message.content = row.message.content.replace(recordedPeer.hook, hook);
  row.origin = { ...row.origin, from, senderTaskId: from, body };
  return { hook, row };
}
