import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexHomeFixture, HOME_ROOT_NAMES, protectInstructionTargets } from "./codexHomeFixture.js";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const snapshotModule = join(deploy, "codex-snapshot.mjs");
const stateCLI = join(deploy, "kaoiro-runner-codex-state.mjs");
const sqliteLock = ".sqlite-maintenance.lock";

describe("production-shaped Codex home classification", () => {
  let dir: string, fixture: ReturnType<typeof createCodexHomeFixture>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "niko542-classify-"));
    fixture = createCodexHomeFixture(dir);
    expect(readdirSync(fixture.home).sort()).toEqual([...HOME_ROOT_NAMES].sort());
    expect(HOME_ROOT_NAMES).toHaveLength(38);
  });
  afterEach(() => {
    if (fixture) protectInstructionTargets(fixture.links, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });

  it("classifies the exact 38-name home through the actual CLI without following instruction links", () => {
    protectInstructionTargets(fixture.links, 0);
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status, result.stderr).toBe(0);
    const entries = JSON.parse(result.stdout);
    const roots = entries.filter((e: { path: string }) => !e.path.includes("/"));
    expect(roots.map((e: { path: string }) => e.path).sort()).toEqual([...HOME_ROOT_NAMES].sort());
    for (const [name, target] of Object.entries(fixture.links)) {
      expect(entries).toContainEqual(expect.objectContaining({ path: name, category: "state", type: "symlink", target }));
      expect(entries.some((e: { path: string }) => e.path.startsWith(`${name}/`))).toBe(false);
      expect(lstatSync(target).mode & 0o777).toBe(0);
    }
    expect(entries).toContainEqual(expect.objectContaining({ path: "plugins", category: "state" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: "plugins/.remote-plugin-install-staging/partial/bundle.json", category: "state" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: `${fixture.plugin}/.codex-plugin/plugin.json`, category: "state" }));
    for (const path of ["app-server-daemon", "packages", "tui-thread-reference-capabilities"]) expect(entries).toContainEqual(expect.objectContaining({ path, category: "state" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: "app-server-control", category: "disposable" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: "cache", category: "disposable" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: sqliteLock, category: "disposable", type: "file", size: 0 }));
    expect(entries).toContainEqual(expect.objectContaining({ path: "auth.json", category: "credential" }));
    expect(existsSync(join(dir, "backup"))).toBe(false);
  });

  it("classifies a nonempty SQLite lock as disposable through the actual CLI", () => {
    writeFileSync(join(fixture.home, sqliteLock), "IGNORED_LOCK_CONTENT");
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContainEqual(expect.objectContaining({ path: sqliteLock, category: "disposable", type: "file", size: 20 }));
  });

  it("restores instruction symlinks and plugin state but omits root cache and SQLite lock and keeps current credentials", () => {
    const before = Object.fromEntries(readdirSync(fixture.home).filter((name) => /\.sqlite(?:-(?:shm|wal|journal))?$/.test(name)).map((name) => [name, createHash("sha256").update(readFileSync(join(fixture.home, name))).digest("hex")]));
    writeFileSync(join(fixture.home, sqliteLock), "IGNORED_LOCK_CONTENT");
    protectInstructionTargets(fixture.links, 0);
    const result = run(["--input-type=module", "-e", `
      import * as fs from 'node:fs';
      import { join } from 'node:path';
      const snap=await import(process.argv[1]);
      const home=process.argv[2],dir=process.argv[3];
      const lock=join(home,'.sqlite-maintenance.lock');
      const lockBefore=fs.lstatSync(lock);
      const before=snap.inventory(home,true);
      const result=await snap.snapshot(home,join(dir,'backup'),{uuid:'fixture',staging:join(dir,'.staging.codex-fixture')});
      const after=snap.inventory(home,true);
      const lockAfter=fs.lstatSync(lock);
      const lockUnchanged={dev:lockAfter.dev,ino:lockAfter.ino,content:fs.readFileSync(lock,'utf8')};
      fs.writeFileSync(join(home,'auth.json'),'REFRESHED_AUTH');
      fs.writeFileSync(join(home,'sessions/old.jsonl'),'AFTER_SNAPSHOT');
      for(const name of ['AGENTS.md','agents','hooks','model-profiles']) {
        fs.unlinkSync(join(home,name)); fs.symlinkSync('/unavailable/new-target',join(home,name));
      }
      snap.prepareRestore(join(dir,'backup'),result.sha256,home,join(dir,'restore'));
      snap.promoteRestore(home,join(dir,'restore'),join(dir,'quarantine'),()=>{});
      console.log(JSON.stringify({before,after,manifest:result.manifest,lockBefore:{dev:lockBefore.dev,ino:lockBefore.ino},lockUnchanged}));
    `, snapshotModule, fixture.home, dir]);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.after).toEqual(output.before);
    expect(output.lockUnchanged).toEqual({ ...output.lockBefore, content: "IGNORED_LOCK_CONTENT" });
    expect.soft(output.manifest.entries, "snapshot manifest must omit the disposable SQLite lock").not.toContainEqual(expect.objectContaining({ path: sqliteLock }));
    expect.soft(existsSync(join(dir, "backup/state", sqliteLock)), "snapshot payload must omit the disposable SQLite lock").toBe(false);
    expect.soft(existsSync(join(fixture.home, sqliteLock)), "restored home must omit the disposable SQLite lock").toBe(false);
    expect(readFileSync(join(dir, "quarantine", sqliteLock), "utf8")).toBe("IGNORED_LOCK_CONTENT");
    expect(output.manifest).not.toHaveProperty("migrationLevels");
    for (const [name, hash] of Object.entries(before)) {
      expect(createHash("sha256").update(readFileSync(join(fixture.home, name))).digest("hex")).toBe(hash);
    }
    for (const [name, target] of Object.entries(fixture.links)) {
      for (const base of [fixture.home, join(dir, "backup/state")]) {
        expect(lstatSync(join(base, name)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(base, name))).toBe(target);
      }
      expect(lstatSync(target).mode & 0o777).toBe(0);
    }
    expect(readFileSync(join(fixture.home, `${fixture.plugin}/skills/sample/SKILL.md`), "utf8")).toBe("INSTALLED_PLUGIN_SKILL\n");
    expect(readFileSync(join(fixture.home, "plugins/data/sample-openai-curated-remote/local.json"), "utf8")).toBe('{"keep":"local-data"}');
    expect(readFileSync(join(fixture.home, "plugins/.remote-plugin-install-staging/partial/bundle.json"), "utf8")).toBe('{"keep":"staging"}');
    expect(existsSync(join(fixture.home, "cache"))).toBe(false);
    expect(existsSync(join(dir, "backup/state/cache"))).toBe(false);
    expect(existsSync(join(dir, "backup/state/auth.json"))).toBe(false);
    expect(readFileSync(join(fixture.home, "auth.json"), "utf8")).toBe("REFRESHED_AUTH");
    expect(readFileSync(join(fixture.home, "sessions/old.jsonl"), "utf8")).toBe("OLD_HISTORY\n");
    expect(output.manifest.entries.some((e: { path: string }) => e.path.startsWith("app-server-control"))).toBe(false);
    for (const base of [fixture.home, join(dir, "backup/state")]) {
      expect(existsSync(join(base, "app-server-control"))).toBe(false);
      expect(readFileSync(join(base, "app-server-daemon/loaded-threads.json"), "utf8")).toBe('["retained-thread"]');
      expect(readFileSync(join(base, "app-server-daemon/settings.json"), "utf8")).toContain('"autoUpdateEnabled":false');
      expect(lstatSync(join(base, "packages/app-server-daemon/releases/fixture/bin/codex")).mode & 0o777).toBe(0o755);
      expect(readlinkSync(join(base, "packages/app-server-daemon/current"))).toBe("releases/fixture");
      expect(lstatSync(join(base, "tui-thread-reference-capabilities/retained-thread")).size).toBe(0);
    }
    expect(existsSync(join(dir, "quarantine/app-server-control/app-server-startup.lock"))).toBe(true);
    expect(readFileSync(join(dir, "backup/manifest.json"), "utf8")).not.toContain("EXTERNAL_NOT_SNAPSHOTTED");
    protectInstructionTargets(fixture.links, 0o700);
    expect(readFileSync(fixture.links["AGENTS.md"]!, "utf8")).toBe("EXTERNAL_INSTRUCTIONS");
    for (const name of ["agents", "hooks", "model-profiles"]) expect(readFileSync(join(fixture.links[name]!, "private.txt"), "utf8")).toBe("EXTERNAL_NOT_SNAPSHOTTED");
  });

  it.each(["unclassified", "plugins-extra", "auth.json.tmp", ".sqlite-maintenance.lock.extra", "cloud-config-bundle-cache.json", ".tmpAb12Cd", "app-server-control-extra", "app-server-daemon-extra", "packages-extra", "tui-thread-reference-capabilities-extra"])("refuses unknown root %s before creating snapshot staging", (name) => {
    writeFileSync(join(fixture.home, name), "DO_NOT_COPY");
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(`Unclassified Codex home entry: ${name}`);
    const snapshot = run(["--input-type=module", "-e", `
      const snap=await import(process.argv[1]);
      await snap.snapshot(process.argv[2],process.argv[3],{uuid:'fixture',staging:process.argv[4]});
    `, snapshotModule, fixture.home, join(dir, "backup"), join(dir, ".staging.codex-fixture")]);
    expect(snapshot.status).not.toBe(0);
    expect(snapshot.stderr).toContain(`Unclassified Codex home entry: ${name}`);
    expect(existsSync(join(dir, "backup"))).toBe(false);
    expect(existsSync(join(dir, ".staging.codex-fixture"))).toBe(false);
  });

  it("refuses a symlink at the SQLite lock name through the actual CLI", () => {
    unlinkSync(join(fixture.home, sqliteLock));
    const target = join(dir, "external-lock");
    writeFileSync(target, "DO_NOT_FOLLOW");
    symlinkSync(target, join(fixture.home, sqliteLock));
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("External database/session storage is unsupported");
    expect(readFileSync(target, "utf8")).toBe("DO_NOT_FOLLOW");
  });
  it.each([
    "app-server-control/app-server-control.sock",
    ...["daemon", "daemon-updater", "app-server", "app-server-updater"].flatMap(stem =>
      ["pid", "pid.tmp", "sock", "ready", "shutdown"].map(suffix => `app-server-daemon/${stem}.${suffix}`)),
    "packages/app-server-daemon/install.lock.d", "packages/standalone/install.lock.d",
  ])("refuses runtime signal %s before CLI admission or snapshot staging", (name) => {
    mkdirSync(join(fixture.home, name, ".."), { recursive: true });
    symlinkSync("/unavailable/runtime-sentinel", join(fixture.home, name));
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain(`CODEX_EXTERNAL_DAEMON_ENTRY: ${name}`);
    expect(result.stderr).toContain("stop external same-home writers");
    const take = run(["--input-type=module", "-e", `
      const snap=await import(process.argv[1]);
      await snap.snapshot(process.argv[2],process.argv[3],{uuid:'fixture',staging:process.argv[4]});
    `, snapshotModule, fixture.home, join(dir, "backup"), join(dir, ".staging.codex-fixture")]);
    expect(take.status).not.toBe(0);
    expect(take.stderr).toContain(`CODEX_EXTERNAL_DAEMON_ENTRY: ${name}`);
    expect(existsSync(join(dir, ".staging.codex-fixture"))).toBe(false);
    expect(lstatSync(join(fixture.home, name)).isSymbolicLink()).toBe(true);
  });

  it.each(["app-server-control", "app-server-daemon", "packages", "tui-thread-reference-capabilities"])("refuses symlink root %s and keeps the previous helper incompatible", (name) => {
    const previous = fileURLToPath(new URL("./fixtures/codex-snapshot-f84297a5.mjs", import.meta.url));
    const oldHome = join(dir, "old-helper-home"); mkdirSync(oldHome, { mode: 0o700 }); mkdirSync(join(oldHome, name));
    const legacy = run(["--input-type=module", "-e", "(await import(process.argv[1])).inventory(process.argv[2])", previous, oldHome]);
    expect(legacy.status).not.toBe(0); expect(legacy.stderr).toContain(`Unclassified Codex home entry: ${name}`);
    rmSync(join(fixture.home, name), { recursive: true }); symlinkSync("/unavailable/daemon-parent", join(fixture.home, name));
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status).toBe(78); expect(result.stderr).toContain(`CODEX_EXTERNAL_DAEMON_CHECK_FAILED: ${name}\n`);
  });

  it("refuses a nested package symlink parent without following it", () => {
    symlinkSync("/unavailable/package-root", join(fixture.home, "packages/standalone"));
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("CODEX_EXTERNAL_DAEMON_CHECK_FAILED: packages/standalone/install.lock.d");
  });

  const locks = ["app-server-control/app-server-startup.lock", "app-server-daemon/daemon.lock",
    ...["daemon", "daemon-updater", "app-server", "app-server-updater"].map(stem => `app-server-daemon/${stem}.pid.lock`),
    "packages/app-server-daemon/install.lock", "packages/standalone/install.lock"];
  it.each(locks)("refuses held lock %s without changing its inode", async (name) => {
    const path = join(fixture.home, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "LOCK_BYTES");
    const before = lstatSync(path);
    const holder = spawn("/usr/bin/flock", ["-x", path, "/bin/sh", "-c", 'printf READY; read release'], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>(resolve => holder.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { holder.stdout.once("data", () => resolve()); holder.once("error", reject); });
      const result = run([stateCLI, "classify", fixture.home]);
      expect(result.status).toBe(78); expect(result.stderr).toContain(`CODEX_EXTERNAL_DAEMON_BUSY: ${name}`);
      expect(lstatSync(path).ino).toBe(before.ino); expect(readFileSync(path, "utf8")).toBe("LOCK_BYTES");
    } finally { holder.stdin.end("release\n"); await closed; }
    expect(run([stateCLI, "classify", fixture.home]).status).toBe(0);
  });

  it.each(["success", "error", "signal", "exit", "null", "throw", "identity", "open", "opened-dev", "opened-ino", "opened-type", "opened-link", "opened-owner", "after-dev", "after-link", "after-owner", "before-type", "before-link", "before-owner", "stat", "close"])("closes each probe descriptor on %s and lets an independent process acquire it", (fault) => {
    const result = run(["--input-type=module", "-e", `
      import fs from 'node:fs'; import cp from 'node:child_process'; import assert from 'node:assert/strict';
      import { syncBuiltinESMExports } from 'node:module';
      const home=process.argv[2], fault=process.argv[3], path=home+'/app-server-control/app-server-startup.lock';
      const realSpawn=cp.spawnSync, realOpen=fs.openSync, realStat=fs.lstatSync, realFstat=fs.fstatSync, realClose=fs.closeSync, fds=[];
      const changed=(st,kind)=>Object.assign(Object.create(st),kind==='dev'?{dev:st.dev+1}:kind==='ino'?{ino:st.ino+1}:kind==='type'?{isFile:()=>false}:kind==='link'?{nlink:2}:{uid:st.uid+1});
      fs.fstatSync=(fd,...args)=>{const st=realFstat(fd,...args);return fds.includes(fd)&&fault.startsWith('opened-')?changed(st,fault.slice(7)):st;};
      fs.openSync=(name,...args)=>{if(String(name)===path&&fault==='open')throw Error('open refused');const fd=realOpen(name,...args);if(String(name)===path)fds.push(fd);return fd;};
      fs.closeSync=fd=>{realClose(fd);if(fds.includes(fd)&&fault==='close')throw Error('close diagnostics');};
      let replaceIdentity=false,firstStat=true;
      fs.lstatSync=(name,...args)=>{if(String(name)===path&&fault==='stat')throw Object.assign(Error('unreadable'),{code:'EACCES'});const st=realStat(name,...args);if(String(name)===path&&firstStat&&fault.startsWith('before-')){firstStat=false;return changed(st,fault.slice(7));}if(String(name)===path&&replaceIdentity)return changed(st,fault==='identity'?'ino':fault.slice(6));return st;};
      cp.spawnSync=(file,args,opts)=>{
        const r=realSpawn(file,args,opts);if(file!=='/usr/bin/flock')return r;
        if(fault==='throw')throw Error('CHECKER_PRIVATE_SENTINEL');
        if(fault==='identity'||fault.startsWith('after-'))replaceIdentity=true;
        if(fault==='error')return {...r,error:Object.assign(Error('CHECKER_PRIVATE_SENTINEL'),{code:'ENOENT'})};
        if(fault==='signal')return {...r,status:null,signal:'SIGTERM'};
        if(fault==='exit')return {...r,status:1};
        if(fault==='null')return {...r,status:null};
        return r;
      };syncBuiltinESMExports();
      const snap=await import(process.argv[1]);let message='';try{snap.assertNoExternalDaemon(home);}catch(e){message=e.message;}
      if(fault==='success')assert.equal(message,'');else assert.equal(message,'CODEX_EXTERNAL_DAEMON_CHECK_FAILED: app-server-control/app-server-startup.lock');
      assert(!message.includes('PRIVATE_SENTINEL'));
      for(const fd of fds)assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
      const reacquire=realSpawn('/usr/bin/flock',['-n',path,'true'],{encoding:'utf8'});
      assert.equal(reacquire.status,0);console.log(JSON.stringify({message,closed:fds.length,reacquire:reacquire.status}));
    `, snapshotModule, fixture.home, fault]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).reacquire).toBe(0);
  });

});
