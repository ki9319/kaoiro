import { expect, it } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { enumerate } from "./scenarios.js";
it("pins the independent bounded event enumeration", () => {
let result = enumerate(6);
let text = JSON.stringify(result) + "\n";
const sixBytes = Buffer.byteLength(text);
if (sixBytes > 1_000_000) { result = enumerate(5); text = JSON.stringify(result) + "\n"; }
// Leave half the combined 2 MB budget for the server expectations.
const path = new URL("../../../../protocol/fixtures/permission-differential/scenarios.json", import.meta.url);
if (process.env.KAOIRO_GENERATE_DIFFERENTIAL === "1") writeFileSync(path, text);
else expect(readFileSync(path, "utf8")).toBe(text);
console.log(JSON.stringify({ depth: result.depth, scenarios: result.rows.length, bytes: Buffer.byteLength(text), six_event_bytes: sixBytes }));

});
