import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { parseModelState, parseSelection, promptTokens, reportedSelection } from "../src/grok/usage.js";

const select = (id: string, currentValue: unknown, values: unknown[]) =>
  ({ id, type: "select", currentValue, options: values.map((value) => ({ value, name: String(value) })) });
const completed = (usage: unknown) => ({ sessionId: "s", update: { sessionUpdate: "response_completed", usage } });

describe("parseModelState", () => {
  const meta = (models: unknown[]) => ({ modelState: { availableModels: models } });
  it("reads the value, name, window, levels and default effort", () => {
    expect(parseModelState(meta([{
      modelId: "m", name: "M", description: "d",
      _meta: { totalContextTokens: 1000, reasoningEfforts: [
        { value: "high", default: true }, { value: "low", default: false }] },
    }]))).toEqual([{
      value: "m", display_name: "M", description: "d", effort_levels: ["high", "low"],
      default_effort: "high", window: 1000,
    }]);
  });
  it("falls back to the id for the name and leaves out what is not usable", () => {
    expect(parseModelState(meta([{ modelId: "m", _meta: { totalContextTokens: 0 } }])))
      .toEqual([{ value: "m", display_name: "m", effort_levels: [] }]);
  });
  it("drops entries without an id and reads nothing from a missing or malformed state", () => {
    expect(parseModelState(meta([{ name: "no id" }, null, 3]))).toEqual([]);
    expect(parseModelState({})).toEqual([]);
    expect(parseModelState(undefined)).toEqual([]);
    expect(parseModelState({ modelState: { availableModels: "x" } })).toEqual([]);
  });
});

describe("parseSelection", () => {
  it("needs both selects with a current value", () => {
    const both = [select("model", "a", ["a", "b"]), select("reasoning_effort", "high", ["high"])];
    expect(parseSelection(both)).toEqual({ model: "a", effort: "high", models: ["a", "b"], efforts: ["high"] });
    expect(parseSelection([both[0]])).toBeUndefined();
    expect(parseSelection([both[1]])).toBeUndefined();
    expect(parseSelection(undefined)).toBeUndefined();
    expect(parseSelection([select("model", "", ["a"]), both[1]])).toBeUndefined();
    expect(parseSelection([{ ...both[0], type: "boolean" }, both[1]])).toBeUndefined();
  });
  it("collects the values of grouped options", () => {
    const grouped = { id: "model", type: "select", currentValue: "a",
      options: [{ group: "g", name: "G", options: [{ value: "a" }, { value: "b" }] }, { value: "c" }] };
    expect(parseSelection([grouped, select("reasoning_effort", "low", ["low"])])?.models).toEqual(["a", "b", "c"]);
  });
});

describe("promptTokens", () => {
  it("adds the input and both cache counts", () => {
    expect(promptTokens(completed({ input_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 3,
      output_tokens: 99 }))).toBe(48);
  });
  it("counts an absent cache field as 0", () => {
    expect(promptTokens(completed({ input_tokens: 5 }))).toBe(5);
  });
  it.each([
    ["no input", { cache_read_input_tokens: 1 }],
    ["a negative input", { input_tokens: -1 }],
    ["a string input", { input_tokens: "5" }],
    ["a non-finite cache count", { input_tokens: 5, cache_read_input_tokens: Number.NaN }],
    ["a string cache count", { input_tokens: 5, cache_creation_input_tokens: "1" }],
    ["no usage", undefined],
  ])("reads nothing for %s", (_name, usage) => {
    expect(promptTokens(completed(usage))).toBeUndefined();
  });
  it("reads nothing from another notification", () => {
    expect(promptTokens({ update: { sessionUpdate: "turn_completed", usage: { input_tokens: 5 } } })).toBeUndefined();
  });
});

describe("reportedSelection", () => {
  it("reads the model and effort of model_changed", () => {
    expect(reportedSelection({ update: { sessionUpdate: "model_changed", model_id: "a", reasoning_effort: "low" } }))
      .toEqual({ model: "a", effort: "low" });
    expect(reportedSelection({ update: { sessionUpdate: "model_changed" } })).toEqual({});
    expect(reportedSelection({ update: { sessionUpdate: "turn_completed", model_id: "a" } })).toBeUndefined();
  });
});
