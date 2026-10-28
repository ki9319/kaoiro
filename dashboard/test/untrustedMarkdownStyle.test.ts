import "./isolation.setup";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";
import { renderUntrustedInline, renderUntrustedMarkdown } from "../src/lib/untrustedMarkdown";

// This checks only this component's CSS. Other stylesheets (e.g. AgentDetail),
// inline styles, inherited variables and visual effects can change rendering;
// the statusLine Playwright check exercises the current card, detail and history.
// Extend the accepted grammar only with a review of the colour invariant.
function check(css: string, link: Element): void {
  const fail = (why: string): never => { throw new Error(`Unsupported markdown CSS: ${why}`); };
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (css.includes("/*") || css.includes("*/")) fail("unclosed comment");
  if (/[@\\'"&]/.test(css)) fail("at-rule, escape, quote or nesting");

  const rules: { selectors: string[]; colour: boolean }[] = [];
  while (css.trim()) {
    const match = /^\s*([^{}]+)\{([^{}]*)\}/.exec(css);
    if (!match) fail("unknown syntax or nesting");
    css = css.slice(match![0].length);
    const selectors = match![1]!.split(",").map((s) => s.trim());
    for (const selector of selectors) {
      const pseudos = selector.match(/:[\w-]+(?:\([^)]*\))?/g) ?? [];
      if (pseudos.some((p) => ![":link", ":visited", ":any-link", ":hover", ":focus", ":focus-visible", ":active"].includes(p))) fail("unsupported pseudo-class");
      try { link.matches(selector); } catch { fail("unsupported selector"); }
    }
    let colour = false;
    for (const declaration of match![2]!.split(";")) {
      if (!declaration.trim()) continue;
      const parts = /^\s*([\w-]+)\s*:\s*([^:;]+)\s*$/.exec(declaration);
      if (!parts) fail("unsupported declaration");
      const property = parts![1]!.toLowerCase();
      const value = parts![2]!.trim();
      if (property === "all" || property === "-webkit-text-fill-color" || property === "--c-thinking" || property === "animation" || property.startsWith("animation-")) fail("forbidden declaration");
      if (property === "color") {
        if (value !== "var(--c-thinking)") fail("competing colour");
        colour = true;
      }
    }
    rules.push({ selectors, colour });
  }
  for (const visited of [false, true]) {
    const covered = rules.some((rule) => rule.colour && rule.selectors.some((selector) => {
      if (visited && /:link\b/.test(selector)) return false;
      if (!visited && /:visited\b/.test(selector)) return false;
      return link.matches(visited ? selector.replace(/:visited\b/g, "") : selector);
    }));
    if (!covered) fail(visited ? "visited colour missing" : "unvisited colour missing");
  }
}

function render(inline = false): Element {
  const rendered = inline ? renderUntrustedInline("[link](https://example.test)") : renderUntrustedMarkdown("[link](https://example.test)");
  if (rendered.kind !== "html") throw new Error("markdown did not render");
  const root = document.createElement("div");
  root.className = "untrusted-markdown test-scope";
  root.innerHTML = rendered.html;
  const link = root.querySelector("a, .md-link");
  if (!link) throw new Error("link missing");
  return link;
}

const valid = ".untrusted-markdown a, .untrusted-markdown .md-link { color: var(--c-thinking); }";

describe("markdown link CSS guard", () => {
  it("checks the compiled component for both renderers", () => {
    const source = readFileSync("src/lib/UntrustedMarkdown.svelte", "utf8");
    const compiled = compile(source, { filename: "UntrustedMarkdown.svelte", cssHash: () => "test-scope" });
    for (const inline of [false, true]) check(compiled.css!.code, render(inline));
  });

  it("accepts harmless comments and separate link states", () => {
    const css = "/* @ { author's } */ /* :global {*/ .untrusted-markdown a:link, .untrusted-markdown a:visited { color: var(--c-thinking); } /*}*/";
    expect(() => check(css, render())).not.toThrow();
    expect(() => check(`/* (unused) a { color: red } */ ${valid}`, render())).not.toThrow();
  });

  it.each([
    ["comment", `${valid} /*`],
    ["at-rule", `${valid} @property --x {}`],
    ["escape", `${valid} a { c\\6flor: red; }`],
    ["quote", `${valid} a { content: 'x'; }`],
    ["nesting", `${valid} a { & b { color: red; } }`],
    ["syntax", `${valid} garbage`],
    ["pseudo", `${valid} a:open { color: var(--c-thinking); }`],
    ["selector", `${valid} a[ { color: var(--c-thinking); }`],
    ["declaration", `${valid} a { nonsense }`],
    ["all", `${valid} a { all: revert; }`],
    ["fill", `${valid} a { -webkit-text-fill-color: red; }`],
    ["variable", `${valid} a { --c-thinking: red; }`],
    ["animation", `${valid} a { animation-name: paint; }`],
    ["existing colour", valid.replace("var(--c-thinking)", "red")],
    ["new colour", `${valid} a:hover { COLOR: red; }`],
    ["unvisited", ".untrusted-markdown a:visited { color: var(--c-thinking); }"],
    ["visited", ".untrusted-markdown a:link { color: var(--c-thinking); }"],
    ["inline", ".untrusted-markdown a { color: var(--c-thinking); }"],
  ])("rejects %s", (name, css) => {
    const reasons: Record<string, string> = {
      comment: "unclosed comment", "at-rule": "at-rule, escape, quote or nesting",
      escape: "at-rule, escape, quote or nesting", quote: "at-rule, escape, quote or nesting",
      nesting: "at-rule, escape, quote or nesting", syntax: "unknown syntax or nesting",
      pseudo: "unsupported pseudo-class", selector: "unsupported selector", declaration: "unsupported declaration",
      all: "forbidden declaration", fill: "forbidden declaration", variable: "forbidden declaration", animation: "forbidden declaration",
      "existing colour": "competing colour", "new colour": "competing colour",
      unvisited: "unvisited colour missing", visited: "visited colour missing", inline: "unvisited colour missing",
    };
    expect(() => check(css, render(name === "inline"))).toThrow(reasons[name]);
  });
});
