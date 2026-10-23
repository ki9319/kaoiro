import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeSources, CANARIES, HELPERS } from "./selection.mjs";

const suppliedRoot = process.argv[2];
assert(suppliedRoot, "usage: node scripts/test-isolation/codemod.mjs ROOT [TYPESCRIPT_PACKAGE_JSON] [--apply]");
const root = resolve(suppliedRoot);
const args = process.argv.slice(3);
const tsPackage = args.find(arg => arg.endsWith("package.json")) ?? join(root, "runner/package.json");
const apply = args.includes("--apply");
const ts = createRequire(tsPackage)("typescript");
const checker = await import(pathToFileURL(join(root, "scripts/test-isolation/check.mjs")));
const { rows, problems } = analyzeSources(root, ts);
assert.deepEqual(problems, [], problems.join("\n"));

const resolveImport = (path, text) => {
  const name = checker.firstImport(text);
  return name && posix.normalize(posix.join(posix.dirname(path), name));
};
const selected = [];
const exempt = [];
const changed = [];
for (const row of rows.filter(candidate => candidate.imports.length > 0)) {
  const { path, text, sourceFile } = row;
  if (HELPERS.includes(path) || CANARIES.includes(path)) {
    exempt.push(path);
    continue;
  }
  selected.push(path);
  const expected = path.startsWith("dashboard/") ? "dashboard/test/isolation.setup.ts" : checker.MODULE;
  const first = sourceFile.statements[0];
  const firstIsTypeOnly = first && ts.isImportDeclaration(first) && first.importClause?.isTypeOnly === true;
  if (resolveImport(path, text) === expected && !firstIsTypeOnly) continue;

  const specifier = posix.relative(posix.dirname(path), expected).replace(/^(?!\.)/, "./");
  assert(!text.startsWith("\uFEFF") && !text.startsWith("#!"), `${path}: explicit header handling required`);
  const generated = `import ${JSON.stringify(specifier)};\n${text}`;
  assert.equal(resolveImport(path, generated), expected, `${path}: generated first import does not resolve to the guard`);
  assert.notEqual(resolveImport(path, `import "./wrong.mjs";\n${text}`), expected,
    `${path}: normalized-path check accepts an incorrect guard path`);
  changed.push(path);
  if (apply) writeFileSync(join(root, path), generated);
}

console.log(`${JSON.stringify({
  typescript: ts.version,
  raw: rows.filter(row => row.imports.length > 0).length,
  selected: selected.length,
  exempt,
  changed: changed.length,
  paths: changed,
  applied: apply,
}, null, 2)}\n`);
