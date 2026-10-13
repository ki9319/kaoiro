import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";

it("reaps an adopted test child inside the isolated namespace", async () => {
  const pid = Number(
    execFileSync(
      "sh",
      ["-c", "sleep 0.05 </dev/null >/dev/null 2>&1 & echo $!"],
      {
        encoding: "utf8",
      },
    ).trim(),
  );
  expect(pid).toBeGreaterThan(1);
  await vi.waitFor(() => expect(existsSync(`/proc/${pid}`)).toBe(false));
});
