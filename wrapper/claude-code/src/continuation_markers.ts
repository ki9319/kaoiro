export const MARKER_PREFIX = "[kaoiro-continuation:";
export const marker = (token: string): string => `${MARKER_PREFIX}${token}]`;
export const escapeNativeScalar = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function reportToken(body: string): string | undefined {
  const candidates = [...body.matchAll(/\[kaoiro-continuation:([^\]\r\n]*)\]/g)];
  if (candidates.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(candidates[0]![1]!) ||
      !body.trimEnd().endsWith(candidates[0]![0])) return undefined;
  return candidates[0]![1];
}

export function reportInstruction(token: string, resumed: boolean): string {
  return `\n\n${resumed ? "The previous kaoiro continuation marker is invalid for this execution. " : ""}` +
    `Append exactly ${marker(token)} as the final text of your final report. Use only this execution's marker.`;
}

export interface NotificationBlock {
  taskId: string;
  toolUseId?: string | undefined;
  outputFile?: string | undefined;
  status?: string | undefined;
  summary: string;
  event?: string | undefined;
  result?: string | undefined;
  workflowMetadata: boolean;
}

/** Parse structure before comparing scalars; escaped tag-looking text stays inert. */
export function parseContinuationBlocks(text: string): NotificationBlock[] | undefined {
  const blocks: NotificationBlock[] = [];
  let remaining = text.trim();
  while (remaining) {
    const match = /^<task-notification>([\s\S]*?)<\/task-notification>/.exec(remaining);
    if (!match || blocks.length === 16) return undefined;
    const fields = new Map<string, string>();
    const order: string[] = [];
    let body = match[1]!.trim();
    while (body) {
      // Workflow usage is structured native metadata, never another notification.
      const field = /^<(task-id|tool-use-id|output-file|status|summary|event|recovery|result|diagnostics|failures)>([^<]*)<\/\1>/.exec(body) ??
        /^<(usage)>(<agent_count>\d+<\/agent_count>(?:<agents_done>\d+<\/agents_done><agents_error>\d+<\/agents_error><agents_skipped>\d+<\/agents_skipped><agents_empty_result>\d+<\/agents_empty_result>)?<subagent_tokens>\d+<\/subagent_tokens><tool_uses>\d+<\/tool_uses><duration_ms>\d+<\/duration_ms>)<\/usage>/.exec(body);
      if (!field || fields.has(field[1]!)) return undefined;
      fields.set(field[1]!, field[2] ?? ""); order.push(field[1]!);
      body = body.slice(field[0].length).trimStart();
    }
    const taskId = fields.get("task-id"), summary = fields.get("summary");
    if (!taskId || summary === undefined || order[0] !== "task-id") return undefined;
    const canonical = ["task-id", "tool-use-id", "output-file", "status", "summary", "event", "recovery", "result", "diagnostics", "failures", "usage"];
    if (order.some((name, i) => i > 0 && canonical.indexOf(name) <= canonical.indexOf(order[i - 1]!))) return undefined;
    blocks.push({ taskId, summary, toolUseId: fields.get("tool-use-id"), outputFile: fields.get("output-file"),
      status: fields.get("status"), event: fields.get("event"), result: fields.get("result"),
      workflowMetadata: ["recovery", "diagnostics", "failures", "usage"].some(name => fields.has(name)) });
    remaining = remaining.slice(match[0].length).trimStart();
  }
  return blocks.length ? blocks : undefined;
}
