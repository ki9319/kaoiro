import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/acp/ speaks ACP only. Engine details reach it as injected parameters
// (AcpExtension, the session/new _meta value), never as names in its source.
interface Rule {
  name: string;
  pattern: RegExp;
  // Prose may use an ordinary word; rules that set this are matched against
  // the source with comments removed. Every other rule also reads comments.
  codeOnly?: boolean;
}
const RULES: readonly Rule[] = [
  { name: "_x.ai namespace", pattern: /_x\.ai/ },
  { name: "GROK_ prefix", pattern: /GROK_/ },
  { name: "grok", pattern: /grok/i },
  { name: "promptId", pattern: /promptId/ },
  { name: "requestId", pattern: /requestId/ },
  { name: "prompt_id", pattern: /prompt_id/ },
  { name: "request_id", pattern: /request_id/ },
  { name: "cancellationCategory", pattern: /cancellationCategory/ },
  { name: "vendor_kind", pattern: /vendor_kind/ },
  { name: "hook_event", pattern: /hook_event/ },
  { name: "rules", pattern: /\brules\b/, codeOnly: true },
  {
    name: "import outside acp/",
    pattern: /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']\.\.\//,
  },
];

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
      i += 1;
    } else if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

export function scanSource(source: string): string[] {
  const code = stripComments(source);
  return RULES.filter((rule) =>
    rule.pattern.test(rule.codeOnly ? code : source),
  ).map((rule) => rule.name);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

export function scanTree(root: string): { file: string; rules: string[] }[] {
  return listFiles(root)
    .map((path) => ({
      file: relative(root, path),
      rules: scanSource(readFileSync(path, "utf8")),
    }))
    .filter((entry) => entry.rules.length > 0);
}

const acpDir = fileURLToPath(new URL("../src/acp/", import.meta.url));

describe("src/acp/ is engine-neutral", () => {
  it("scans the real tree and finds no engine-specific name", () => {
    const files = listFiles(acpDir).map((path) => relative(acpDir, path));
    // Guard against a vacuous pass: the scan must see the known modules.
    expect(files).toEqual(
      expect.arrayContaining(["connection.ts", "session.ts"]),
    );
    expect(scanTree(acpDir)).toEqual([]);
  });
});

describe("the detector itself", () => {
  const leaks: [string, string][] = [
    ["_x.ai namespace", 'const m = "_x.ai/session_notification";'],
    ["GROK_ prefix", "const k = process.env.GROK_HOME;"],
    ["grok", "// talks to Grok Build"],
    ["promptId", "const id = meta.promptId;"],
    ["requestId", "const id = meta.requestId;"],
    ["prompt_id", "const id = update.prompt_id;"],
    ["request_id", "const id = { request_id: 1 };"],
    ["cancellationCategory", "meta.cancellationCategory === 'x'"],
    ["vendor_kind", "type T = { vendor_kind?: string };"],
    ["hook_event", "const e = note.hook_event;"],
    ["rules", "_meta: { rules }"],
    ["rules", "const r = { rules: persona };"],
    ["rules", "const r = meta.rules;"],
    ["rules", 'const r = meta["rules"];'],
    ["import outside acp/", 'import { x } from "../grok/wire.js";'],
    ["import outside acp/", 'const m = await import("../grok/wire.js");'],
    ["import outside acp/", 'const m = require("../grok/wire.js");'],
  ];
  it.each(leaks)("flags %s", (rule, source) => {
    expect(scanSource(source)).toContain(rule);
  });

  it("reads comments for every rule except the ordinary word", () => {
    for (const [rule, source] of leaks) {
      if (rule === "rules") continue;
      expect(scanSource(`// ${source}`)).toContain(rule);
      expect(scanSource(`/* ${source} */`)).toContain(rule);
    }
  });

  it("lets prose use the word rules in a comment", () => {
    expect(scanSource("// the persona rules are injected\nconst a = 1;")).toEqual(
      [],
    );
    expect(scanSource("/* the rules,\n more rules */\nconst a = 1;")).toEqual([]);
  });

  it("still sees rules in code after a comment or a URL string", () => {
    expect(scanSource("const a = 1; // note\nconst rules = 2;")).toContain(
      "rules",
    );
    expect(scanSource('const u = "https://x"; const rules = 2;')).toContain(
      "rules",
    );
    expect(scanSource("/* c */ const rules = 2;")).toContain("rules");
  });

  it("passes ACP-only code", () => {
    expect(
      scanSource(
        [
          'import * as acp from "@agentclientprotocol/sdk";',
          'import { safeName } from "./connection.js";',
          "// Extension methods start with an underscore.",
          'const method = "session/update";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("walks subdirectories and reports the file", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-boundary-"));
    try {
      mkdirSync(join(root, "deep", "er"), { recursive: true });
      writeFileSync(join(root, "ok.ts"), "export const a = 1;\n");
      expect(scanTree(root)).toEqual([]);
      writeFileSync(
        join(root, "deep", "er", "leak.ts"),
        'export const m = "_x.ai/y";\n',
      );
      expect(scanTree(root)).toEqual([
        { file: join("deep", "er", "leak.ts"), rules: ["_x.ai namespace"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
