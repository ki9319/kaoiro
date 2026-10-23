import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cgroupFixture } from "./codexCgroupFixture.js";
import { makeReleaseTarball, revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";

describe.skipIf(process.platform !== "linux")("kept state-aware recovery safeguards", () => {
  let dir: string, root: string, home: string, conf: string, group: string, ctl: string, archive: string, nodeOptions: string;
  const A = revisionOf("fuji528-source"), B = revisionOf("fuji528-target");
  const main = 900001;
  const write = (path: string, value: string) => writeFileSync(path, value, { mode: 0o600 });
  const proc = (pid: number, uid: number, member = "/kaoiro-test") => {
    const base = join(dir, "fake-proc", String(pid)); mkdirSync(base, { recursive: true });
    const fields = Array<string>(20).fill("0"); fields[0] = "S"; fields[19] = "1";
    write(join(base, "stat"), `${pid} (fixture) ${fields.join(" ")}`);
    write(join(base, "cgroup"), `0::${member}\n`);
    write(join(base, "status"), `Name:\tapt-helper\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    write(join(base, "environ"), `CODEX_HOME=${home}\0`);
  };
  const calls = () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "";
  const trigger = (name: string, value = "1") => write(join(dir, name), value);
  const update = () => runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "fuji528", "--tarball", archive, "--codex-home", home, "--codex-backup-dir", join(dir, "backup")], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
  const transactions = () => existsSync(join(root, "codex-state/transactions")) ? readdirSync(join(root, "codex-state/transactions")).map((f) => JSON.parse(readFileSync(join(root, "codex-state/transactions", f), "utf8"))) : [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-state-keep-"));
    root = join(dir, "install"); home = join(dir, "codex"); conf = join(dir, "config");
    for (const p of [root, home, conf]) mkdirSync(p, { mode: 0o700 });
    mkdirSync(join(home, "sessions")); write(join(home, "sessions/old.jsonl"), "HISTORY"); write(join(home, "auth.json"), "TOKEN");
    write(join(conf, "runner.env"), `CODEX_HOME='${home}'\n`); write(join(dir, "unit"), "synthetic unit");
    writeReleaseTree(join(root, "releases", A), A);
    const extraFiles: Record<string, string> = {};
    const mutation = process.env.KAOIRO_TEST_528_MUTATION;
    const change = (name: string, edit: (text: string) => string) => {
      const original = readFileSync(join(root, "releases", A, name), "utf8"), changed = edit(original);
      expect(changed).not.toBe(original); extraFiles[name] = changed;
    };
    if (mutation === "restart-phase") change("deploy/kaoiro-runner-codex-state.mjs", (s) => s.replace(
      '  must((tx.mode === "forward" && ["prepared", "stopped"].includes(tx.phase)) || (tx.mode === "restore" && tx.phase === "restore-prepared"), "Source restart is unsafe after state preparation or target authorization");',
      '  must(true, "Source restart is unsafe after state preparation or target authorization");',
    ));
    if (mutation) expect(["restart-phase"]).toContain(mutation);
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    symlinkSync(`releases/${A}`, join(root, "current"));
    mkdirSync(join(dir, "tarball")); archive = makeReleaseTarball(join(dir, "tarball"), B, { extraFiles });
    const cg = cgroupFixture(dir); group = cg.group;
    proc(main, process.getuid!()); write(join(group, "cgroup.procs"), `${main}\n`);
    write(join(dir, "active"), "active");
    const preload = join(dir, "process-preload.mjs");
    write(preload, `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const dir=${JSON.stringify(dir)}, root=${JSON.stringify(root)}, home=${JSON.stringify(home)}, group=${JSON.stringify(group)};
const originalRead=fs.readFileSync, originalRename=fs.renameSync;
const exists=p=>fs.existsSync(dir+'/'+p);
const mapped=p=>typeof p==='string' && p.startsWith('/proc/') ? dir+'/fake-proc'+p.slice(5) : p;
fs.readFileSync=(p,...args)=>{
 if(typeof p==='string' && p.startsWith('/proc/')) {
  const m=/^\\/proc\\/([1-9][0-9]*)\\/stat$/.exec(p);
  if(m && Number(m[1])!==${main}) {
   const fields=Array(20).fill('0');fields[0]='S';fields[1]=/^\\d+$/.test(process.argv.at(-1)||'')?process.argv.at(-1):String(process.ppid);fields[19]='1';
   return m[1]+' (synthetic-owner) '+fields.join(' ');
  }
  const result=originalRead(mapped(p),...args);
  return result;
 }
 return originalRead(p,...args);
};
for(const name of ['lstatSync','statSync','existsSync']) {const original=fs[name];fs[name]=(p,...args)=>original(mapped(p),...args);}
const readdir=fs.readdirSync;fs.readdirSync=(p,...args)=>{if(typeof p==='string' && (p==='/proc' || p.startsWith('/proc/'))) throw new Error('Host process scan forbidden');return readdir(p,...args);};
process.kill=()=>{throw new Error('Actual signals forbidden in synthetic fixture');};
const copy=fs.copyFileSync;fs.copyFileSync=(from,to,...args)=>{if(exists('copy-fault') && String(to).startsWith(dir+'/.staging.codex-')) throw new Error('injected backup copy failure');return copy(from,to,...args);};
fs.renameSync=(from,to)=>{
 if(exists('backup-fault') && String(to)===dir+'/backup') {originalRename(from,to);throw new Error('injected after backup publication');}
 if(exists('phase-fault') && String(to).startsWith(root+'/codex-state/transactions/') && JSON.parse(originalRead(from,'utf8')).phase==='snapshot-verified') throw new Error('injected snapshot phase-save failure');
 return originalRename(from,to);
};
syncBuiltinESMExports();
`);
    nodeOptions = `${process.env.NODE_OPTIONS || ""} --import=${cg.preload} --import=${preload}`;
    ctl = join(dir, "systemctl");
    writeFileSync(ctl, `#!${process.execPath}
const fs=require('node:fs');
const dir=${JSON.stringify(dir)}, root=${JSON.stringify(root)}, home=${JSON.stringify(home)}, conf=${JSON.stringify(conf)}, group=${JSON.stringify(group)};
const args=process.argv.slice(2), prop=(args.find(a=>a.startsWith('--property='))||'').slice(11);
const exists=n=>fs.existsSync(dir+'/'+n), write=(p,v)=>fs.writeFileSync(p,v), active=fs.readFileSync(dir+'/active','utf8');
if(args.includes('stop')) {
 fs.appendFileSync(dir+'/calls','stop\\n');
 if(exists('reject-stop-active')) process.exit(77);
 write(dir+'/active',exists('transitional')?'deactivating':'inactive');
 const clear=p=>{write(p+'/cgroup.procs','');for(const entry of fs.readdirSync(p,{withFileTypes:true})) if(entry.isDirectory()) clear(p+'/'+entry.name);};clear(group);write(group+'/cgroup.events','populated 0\\n');
 if(exists('late-populated')) {write(group+'/cgroup.procs','${main}\\n');write(group+'/cgroup.events','populated 1\\n');}
 if(exists('late-unknown')) write(home+'/unknown-token','secret');
 if(exists('late-config')) fs.appendFileSync(conf+'/runner.env','TOKEN=changed\\n');
 if(exists('late-home')) {fs.renameSync(home,dir+'/old-home');fs.mkdirSync(home,{mode:0o700});}
 if(exists('late-release')) fs.appendFileSync(root+'/releases/${A}/dist/stub_dep.js','\\n// changed\\n');
 if(exists('links-held')) fs.mkdirSync(root+'/.lock.links');
 if(exists('late-link')) {fs.unlinkSync(root+'/current');fs.symlinkSync('releases/${B}',root+'/current');}
 if(exists('lost-owner')) fs.unlinkSync(root+'/.lock.update/codex-owner.json');
 if(exists('unsafe-phase')) {const p=root+'/codex-state/transactions/';for(const f of fs.readdirSync(p)){const tx=JSON.parse(fs.readFileSync(p+f));tx.phase=fs.readFileSync(dir+'/unsafe-phase','utf8');write(p+f,JSON.stringify(tx));}}
 if(exists('reject-stop-inactive')) process.exit(77);
}
else if(args.includes('start')) {fs.appendFileSync(dir+'/calls','start\\n');if(exists('fail-start')) process.exit(66);if(!exists('no-start')) write(dir+'/active','active');if(exists('no-mainpid')) write(dir+'/bad-mainpid','1');if(exists('bad-live')) {fs.mkdirSync(dir+'/other-home',{mode:0o700});write(dir+'/fake-proc/${main}/environ','CODEX_HOME='+dir+'/other-home\\0');}}
else if(args.includes('show-environment')) console.log('HOME='+dir+'\\nKAOIRO_RUNNER_DIR='+conf);
else if(args.includes('show')) {
 const shim=root+'/current/deploy/kaoiro-runner-launch.sh';
 if(prop==='ActiveState' && exists('before-state-fault') && fs.existsSync(root+'/codex-state/transactions') && fs.readdirSync(root+'/codex-state/transactions').length>0 && !exists('calls')) {if(fs.readFileSync(dir+'/before-state-fault','utf8')==='error') process.exit(67);console.log('deactivating');process.exit(0);}
 const values={Transient:'no',ExecStart:'{ path='+shim+' ; argv[]='+shim+' ; ignore_errors=no }',KillMode:'control-group',MainPID:active==='active'&&!exists('bad-mainpid')?'${main}':'0',ActiveState:active,ControlGroup:exists('group-path')?fs.readFileSync(dir+'/group-path','utf8'):'/kaoiro-test',Id:'fuji528.service',FragmentPath:dir+'/unit'};
 console.log(values[prop||'ExecStart']||'');
}
`, { mode: 0o755 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it.each(["late-unknown", "copy-fault", "backup-fault", "phase-fault"])("resumes source after %s and retains incomplete artifacts", (fault) => {
    trigger(fault); const inode = statSync(home).ino;
    const result = update(); expect(result.status, result.stderr).toBe(78); expect(calls()).toBe("stop\nstart\n");
    expect(result.stderr).toContain("unchanged source was resumed"); expect(transactions()[0].phase).toBe("stopped");
    expect(existsSync(join(dir, "backup"))).toBe(["backup-fault", "phase-fault"].includes(fault)); expect(statSync(home).ino).toBe(inode);
    expect(existsSync(transactions()[0].staging)).toBe(fault === "copy-fault");
    expect(existsSync(join(root, "codex-state/backups", transactions()[0].uuid + ".json"))).toBe(fault === "phase-fault");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("TOKEN");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it.each(["reject-stop-active", "reject-stop-inactive", "transitional"])("handles %s without losing the stop status", (fault) => {
    trigger(fault); const result = update(); expect(result.status, result.stderr).toBe(fault === "transitional" ? 78 : 77);
    expect(calls()).toBe(fault === "reject-stop-inactive" ? "stop\nstart\n" : "stop\n");
    expect(result.stderr).toContain(fault === "reject-stop-active" ? "unchanged source remains running" : fault === "transitional" ? "source recovery refused" : "unchanged source was resumed");
  });
  it.each(["error", "transitional"])("refuses a late %s activity read before stop", (mode) => {
    trigger("before-state-fault", mode); const result = update(); expect(result.status, result.stderr).toBe(78);
    expect(calls()).toBe(""); expect(transactions()[0].phase).toBe("prepared");
    expect(result.stderr).toContain(mode === "error" ? "Cannot read source activity before stop" : "Source activity is transitional or unknown before stop");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it.each(["late-config", "late-link", "lost-owner", "late-home", "late-release", "links-held"])("refuses source restart after %s", (fault) => {
    trigger("late-unknown"); trigger(fault); const result = update(); expect(result.status).toBe(78);
    expect(calls()).toBe("stop\n"); expect(result.stderr).toContain("source recovery refused");
  });
  it.each(["restore-intent", "start-attempted", "switch-authorized", "corrupt"])("refuses source restart in %s", (phase) => {
    trigger("unsafe-phase", phase); const result = update(); expect(result.status).toBe(78);
    expect(calls()).toBe("stop\n"); expect(result.stderr).toContain(phase === "corrupt" ? "Malformed state transaction phase" : "Source restart is unsafe");
  });
  it.each(["fail-start", "no-start", "no-mainpid", "bad-live"])("reports %s as failed recovery", (fault) => {
    trigger("late-unknown"); trigger(fault); const result = update(); expect(result.status).toBe(78);
    expect(calls()).toBe("stop\nstart\n"); expect(result.stderr).not.toContain("unchanged source was resumed");
    expect(result.stderr).toContain(fault === "fail-start" ? "source restart failed" : "source restart verification failed");
  });
  it.each(["active", "inactive"])("resumes a failed restore only when source began %s", (activity) => {
    const forward = update(); expect(forward.status, forward.stderr).toBe(0);
    write(join(dir, "active"), activity); trigger("late-populated");
    const inode = statSync(home).ino;
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "fuji528", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
    expect(result.status, result.stderr).toBe(78);
    expect(calls()).toBe(activity === "active" ? "stop\nstart\nstop\nstart\n" : "stop\nstart\nstop\n");
    expect(result.stderr).toContain(activity === "active" ? "unchanged source was resumed" : "source was already stopped");
    expect(statSync(home).ino).toBe(inode); expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("TOKEN");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(transactions().find((t) => t.mode === "restore").phase).toBe("restore-prepared");
  });
});
