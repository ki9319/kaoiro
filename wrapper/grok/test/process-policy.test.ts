import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { GrokProcess } from "../src/grok/process.js";
afterEach(() => vi.restoreAllMocks());
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
