import "./isolation.setup";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import { expect, it } from "vitest";
import { renderUntrustedInline, renderUntrustedMarkdown } from "../src/lib/untrustedMarkdown";

it("sets a theme colour on full and inline markdown links", () => {
  const source = readFileSync("src/lib/UntrustedMarkdown.svelte", "utf8");
  const compiled = compile(source, { filename: "UntrustedMarkdown.svelte", cssHash: () => "test-scope" });
  const style = document.createElement("style");
  style.textContent = compiled.css!.code;
  document.head.append(style);

  try {
    for (const rendered of [renderUntrustedMarkdown("[link](https://example.test)"), renderUntrustedInline("[link](https://example.test)")]) {
      expect(rendered.kind).toBe("html");
      if (rendered.kind !== "html") throw new Error("markdown did not render");
      const root = document.createElement("div");
      root.className = "untrusted-markdown test-scope";
      root.innerHTML = rendered.html;
      const link = root.querySelector("a, .md-link");
      expect(link).not.toBeNull();
      const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.selectorText.split(",").some((selector) => link!.matches(selector.trim())),
      );
      const colours = rules.map((rule) => rule.style.getPropertyValue("color")).filter(Boolean);
      expect(colours.length).toBeGreaterThan(0);
      expect(colours.every((value) => value === "var(--c-thinking)")).toBe(true);
    }
  } finally {
    style.remove();
  }
});
