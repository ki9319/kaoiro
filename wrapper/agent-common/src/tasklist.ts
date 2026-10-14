// Shared tasklist wire shaping (issue #178, ADR-0049). Both engine adapters
// receive whole-list snapshots, so keeping the bounds and omission accounting
// here prevents Claude/Codex drift before either reaches the common task
// envelope builder.

import { clipUtf8Head } from "@kaoiro/wrapper-core";
import type {
  TasklistItem,
  TasklistItemStatus,
  TasklistOmitted,
} from "./types.js";

/** Reserved task identity for an agent's single tasklist entity. */
export const TASKLIST_TASK_ID = "tasklist";
/** Maximum number of real source items rendered in one snapshot. */
export const MAX_TASKLIST_ITEMS = 50;
/** Maximum UTF-8 size of one visible item text. */
export const MAX_TASKLIST_ITEM_TEXT_BYTES = 256;
/** Defense-in-depth JSON ceiling mirrored by server ingress validation. */
export const MAX_TASKLIST_ITEMS_JSON_BYTES = 16_384;

export interface TasklistSourceItem {
  text: string;
  status: TasklistItemStatus;
}

export interface TasklistSnapshot {
  items: TasklistItem[];
  omitted?: TasklistOmitted;
}

/**
 * Normalizes an engine's whole-list source event into the bounded wire form.
 * The first items are retained in source order. Any remainder is represented
 * by an explicit count and completed tally, so the operator can see that the
 * detail is partial while aggregate progress remains accurate. The JSON cap
 * is checked incrementally because quote/backslash escaping can make a
 * byte-limited source string larger on the JSON wire.
 */
export function normalizeTasklist(
  source: readonly TasklistSourceItem[],
): TasklistSnapshot {
  const items: TasklistItem[] = [];

  for (const candidate of source) {
    if (items.length >= MAX_TASKLIST_ITEMS) break;
    const item: TasklistItem = {
      text: clipUtf8Head(candidate.text, MAX_TASKLIST_ITEM_TEXT_BYTES),
      status: candidate.status,
    };
    if (
      Buffer.byteLength(JSON.stringify([...items, item]), "utf8") >
      MAX_TASKLIST_ITEMS_JSON_BYTES
    ) {
      break;
    }
    items.push(item);
  }

  const omittedSource = source.slice(items.length);
  if (omittedSource.length === 0) return { items };

  return {
    items,
    omitted: {
      count: omittedSource.length,
      completed: omittedSource.filter((item) => item.status === "completed").length,
    },
  };
}
