/** One model Grok lists in `initialize` `_meta.modelState`. */
export interface GrokModel {
  value: string;
  display_name: string;
  description?: string;
  effort_levels: string[];
  default_effort?: string;
  /** `totalContextTokens`; kept off the published catalog. */
  window?: number;
}

/** What `configOptions` says is selected now, and what it offers. */
export interface GrokSelection {
  model: string;
  effort: string;
  models: string[];
  efforts: string[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The model list of the `initialize` response's `_meta`. */
export function parseModelState(meta: unknown): GrokModel[] {
  const available = record(record(meta)?.modelState)?.availableModels;
  if (!Array.isArray(available)) return [];
  const models: GrokModel[] = [];
  for (const entry of available) {
    const item = record(entry);
    const value = text(item?.modelId);
    if (!item || !value) continue;
    const modelMeta = record(item._meta);
    const efforts = Array.isArray(modelMeta?.reasoningEfforts)
      ? modelMeta.reasoningEfforts.map(record).filter((e) => text(e?.value))
      : [];
    const defaultEffort = text(efforts.find((e) => e?.default === true)?.value);
    const window = modelMeta?.totalContextTokens;
    models.push({
      value,
      display_name: text(item.name) ?? value,
      ...(text(item.description) ? { description: text(item.description)! } : {}),
      effort_levels: efforts.map((e) => text(e?.value)!),
      ...(defaultEffort ? { default_effort: defaultEffort } : {}),
      ...(typeof window === "number" && Number.isFinite(window) && window > 0
        ? { window }
        : {}),
    });
  }
  return models;
}

function selectOption(options: unknown, id: string) {
  if (!Array.isArray(options)) return undefined;
  const option = options.map(record).find((o) => o?.id === id);
  if (!option || option.type !== "select") return undefined;
  const current = text(option.currentValue);
  if (!current || !Array.isArray(option.options)) return undefined;
  const values: string[] = [];
  for (const entry of option.options) {
    const item = record(entry);
    if (text(item?.value)) values.push(text(item!.value)!);
    else if (Array.isArray(item?.options))
      for (const inner of item.options) if (text(record(inner)?.value)) values.push(text(record(inner)!.value)!);
  }
  return { current, values };
}

/** Both selects must be present: a missing one fails the whole reading. */
export function parseSelection(options: unknown): GrokSelection | undefined {
  const model = selectOption(options, "model");
  const effort = selectOption(options, "reasoning_effort");
  if (!model || !effort) return undefined;
  return { model: model.current, effort: effort.current, models: model.values, efforts: effort.values };
}

/**
 * The prompt size of one model call, `input + cache read + cache creation`,
 * from a `response_completed` vendor notification. `/context` shows the last
 * call's value (issue #593); the cache fields default to 0 when absent.
 */
export function promptTokens(notification: Record<string, unknown>): number | undefined {
  const update = record(notification.update);
  if (update?.sessionUpdate !== "response_completed") return undefined;
  const usage = record(update.usage);
  const input = count(usage?.input_tokens);
  if (input === undefined) return undefined;
  const optional = (value: unknown) => (value === undefined ? 0 : count(value));
  const read = optional(usage?.cache_read_input_tokens);
  const created = optional(usage?.cache_creation_input_tokens);
  return read === undefined || created === undefined ? undefined : input + read + created;
}

/** A `model_changed` vendor notification's model and effort. */
export function reportedSelection(
  notification: Record<string, unknown>,
): { model?: string; effort?: string } | undefined {
  const update = record(notification.update);
  if (update?.sessionUpdate !== "model_changed") return undefined;
  return {
    ...(text(update.model_id) ? { model: text(update.model_id)! } : {}),
    ...(text(update.reasoning_effort) ? { effort: text(update.reasoning_effort)! } : {}),
  };
}
