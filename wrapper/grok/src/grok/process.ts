import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { GrokLaunchError } from "./errors.js";

export const SHUTDOWN_GRACE_MS = 3_000;

export class GrokProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  #closing: Promise<void> | undefined;

  constructor(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(
      executable,
      ["--no-auto-update", "agent", "--no-leader", "stdio"],
      {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: "pipe",
      },
    );
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", () =>
        reject(new GrokLaunchError("grok spawn failed")),
      );
      this.child.once("exit", () => resolve());
    });
    // Startup may fail before the ACP reader has attached its own waiter.
    void this.exited.catch(() => {});
    this.child.stderr.resume();
  }

  #signal(signal: NodeJS.Signals | 0): boolean {
    const pid = this.child.pid;
    if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0)
      return false;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#terminate());
  }

  async #terminate(): Promise<void> {
    this.child.stdin.end();
    if (!this.#signal("SIGTERM")) return;
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.#signal(0) && Date.now() < deadline) {
      await delay(25);
    }
    if (this.#signal(0)) this.#signal("SIGKILL");
    await this.exited.catch(() => {});
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
