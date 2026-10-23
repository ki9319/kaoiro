import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect } from "vitest";
import type { WrapperConfig } from "../src/index.js";

export function expectWhoamiDirectoryName(
  actual: unknown,
  expectedName: string,
  expectedPersona: WrapperConfig["persona"],
  context: string,
): void {
  expect(actual, `${context}: whoami.directory-name`).toMatchObject({
    display_name: expectedName,
    persona: expectedPersona,
  });
}

export function expectWhoamiDirectoryNameUnavailable(actual: unknown, context: string): void {
  expect(actual, `${context}: whoami.directory-name-unavailable`).not.toHaveProperty("display_name");
}
