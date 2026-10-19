// NODE_OPTIONS preload for child processes (docs/contributing/test-isolation.md).
// --require keeps Node's main-entry loader unchanged, so a Node script with a
// non-JavaScript extension (fake-docker.sh) still starts; --import would route
// every main entry through the ES module loader. Needs require(esm), Node >= 22.12.
require("./test-isolation.mjs");
