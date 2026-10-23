import "../../../scripts/test/fixtures/test-isolation.mjs";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { GrokProcess } from "../src/grok/process.js";
afterEach(() => vi.restoreAllMocks());
it("starts an unshared stdio agent", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: { end() {} },
    stderr: { resume() {}, destroy() {} },
    stdout: { destroy() {} },
  });
  mocks.spawn.mockReturnValue(child);
  const owned = new GrokProcess("grok", "fixture", {});
  expect(mocks.spawn).toHaveBeenLastCalledWith(
    "grok",
    ["--no-auto-update", "agent", "--no-leader", "stdio"],
    {
      cwd: "fixture",
      env: {},
      detached: process.platform !== "win32",
      stdio: "pipe",
    },
  );
  await owned.close();
});
it.each([undefined, 0, -1, NaN])(
  "never signals an invalid owned pid %s",
  async (pid) => {
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdin: { end() {} },
      stderr: { resume() {}, destroy() {} },
      stdout: { destroy() {} },
    });
    mocks.spawn.mockReturnValue(child);
    // This fake process table makes guard mutations safe: no OS signal is sent.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("fixture process absent"), {
        code: "ESRCH",
      });
    });
    const owned = new GrokProcess("fixture", ".", {});
    await owned.close();
    expect(kill).not.toHaveBeenCalled();
  },
);
