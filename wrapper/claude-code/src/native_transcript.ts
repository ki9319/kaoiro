import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

export type NativeRow = Record<string, unknown>;
export interface NativeAnchor {
  readonly uuid: string;
  readonly promptId: string;
  readonly digest: string;
  readonly row: NativeRow;
}
export class NativeEvidenceError extends Error {}
const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

/** One live file epoch. A failed epoch is never repaired by later good bytes. */
export class NativeTranscriptReader {
  readonly path: string;
  readonly sessionId: string;
  #identity?: string;
  #length = 0;
  #hash = digest("");
  #failed = false;
  #serial: Promise<unknown> = Promise.resolve();
  constructor(path: string, sessionId: string) { this.path = path; this.sessionId = sessionId; }
  get failed(): boolean { return this.#failed; }
  invalidate(): void { this.#failed = true; }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#serial.then(operation);
    this.#serial = pending.catch(() => {});
    return pending;
  }
  async #read(): Promise<Array<{ row: NativeRow; digest: string }>> {
    if (this.#failed) throw new NativeEvidenceError("native transcript epoch invalid");
    try {
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw Error("not regular");
        const identity = `${before.dev}:${before.ino}`;
        if (this.#identity !== undefined && this.#identity !== identity) throw Error("replaced");
        const bytes = await handle.readFile();
        const after = await stat(this.path);
        if (!after.isFile() || `${after.dev}:${after.ino}` !== identity) throw Error("path changed");
        if (bytes.length < this.#length || digest(bytes.subarray(0, this.#length)) !== this.#hash) throw Error("committed prefix changed");
        const complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(complete);
        const rows = text === "" ? [] : text.slice(0, -1).split("\n").map(line => {
          const row: unknown = JSON.parse(line);
          if (!row || typeof row !== "object" || Array.isArray(row)) throw Error("invalid row");
          return { row: row as NativeRow, digest: digest(line) };
        });
        this.#identity = identity;
        this.#length = complete.length;
        this.#hash = digest(complete);
        return rows;
      } finally { await handle.close(); }
    } catch (error) {
      if (this.#identity === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      this.#failed = true;
      throw new NativeEvidenceError("native transcript identity or committed evidence changed");
    }
  }

  capture(promptId: string): Promise<NativeAnchor | undefined> {
    return this.#enqueue(async () => {
      const rows = await this.#read();
      const matching = rows.filter(({ row }) => row.type === "user" && row.sessionId === this.sessionId &&
        row.promptId === promptId && row.isSidechain === false &&
        (row.turnPosition as { promptIndex?: unknown } | undefined)?.promptIndex === 0);
      if (matching.length > 1) { this.invalidate(); throw new NativeEvidenceError("conflicting native opener"); }
      const selected = matching[0];
      if (!selected) return undefined;
      if (typeof selected.row.uuid !== "string" || !selected.row.uuid) {
        this.invalidate(); throw new NativeEvidenceError("native opener identity missing");
      }
      return Object.freeze({ uuid: selected.row.uuid, promptId, digest: selected.digest,
        row: structuredClone(selected.row) });
    });
  }
  validate(anchor: NativeAnchor): Promise<void> {
    return this.#enqueue(async () => {
      const rows = await this.#read();
      const matches = rows.filter(({ row }) => row.uuid === anchor.uuid);
      if (matches.length !== 1 || matches[0]!.digest !== anchor.digest) {
        this.invalidate(); throw new NativeEvidenceError("native opener anchor lost");
      }
    });
  }
}
