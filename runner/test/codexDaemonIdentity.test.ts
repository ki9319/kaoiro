import "../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const snapshot = fileURLToPath(new URL("../deploy/codex-snapshot.mjs", import.meta.url));

it.each(["dev", "ino", "both"])("rejects a changed open-file %s identity before invoking flock", kind => {
  const home = mkdtempSync(join(tmpdir(), "fuji859-identity-"));
  mkdirSync(join(home, "app-server-control"));
  writeFileSync(join(home, "app-server-control/app-server-startup.lock"), "");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import cp from 'node:child_process'; import assert from 'node:assert/strict';
      import { syncBuiltinESMExports } from 'node:module';
      const home=process.argv[2],kind=process.argv[3],lock=home+'/app-server-control/app-server-startup.lock';
      const stat=fs.lstatSync,fstat=fs.fstatSync,spawn=cp.spawnSync;let opened=false,checkerCalls=0;
      const changed=s=>Object.assign(Object.create(s),{
        dev:s.dev+(kind==='ino'?0:1),ino:s.ino+(kind==='dev'?0:1)
      });
      fs.fstatSync=fd=>{opened=true;return changed(fstat(fd));};
      // The new pathname identity agrees with the opened descriptor. A
      // post-probe comparison alone would accept this replacement.
      fs.lstatSync=(name,...args)=>{const s=stat(name,...args);return String(name)===lock&&opened?changed(s):s;};
      cp.spawnSync=(...args)=>{checkerCalls++;return spawn(...args);};syncBuiltinESMExports();
      const snap=await import(process.argv[1]);
      assert.throws(()=>snap.assertNoExternalDaemon(home),{message:'CODEX_EXTERNAL_DAEMON_CHECK_FAILED: app-server-control/app-server-startup.lock'});
      assert.equal(checkerCalls,0,'do not probe a different file before rejecting it');
      assert.equal(spawn('/usr/bin/flock',['-n',lock,'true'],{encoding:'utf8'}).status,0);
    `, snapshot, home, kind], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
