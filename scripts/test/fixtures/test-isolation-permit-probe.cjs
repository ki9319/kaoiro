// Self-test helper for test-isolation.test.mjs: a permit made from a file in
// the permit table, for probes that run as -e code or from a temp file.
"use strict";
const { permitHostAccess } = require("./test-isolation.cjs");

exports.permitSelfProbe = () =>
  permitHostAccess({ kinds: ["systemd"], optIn: "KAOIRO_ISOLATION_SELF_PROBE", reason: "isolation self-test" });
