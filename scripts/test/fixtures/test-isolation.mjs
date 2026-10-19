// Test-only isolation contract (issue 577, docs/contributing/test-isolation.md).
// Load it first in every test process: a root process neutralises inherited
// host pointers and credentials once; every spawn re-applies them after product
// code has built the child environment and hands the guard on to Node children.
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import workerThreads from "node:worker_threads";

const STATE = Symbol.for("kaoiro.test.isolation");
// Built from the path string: under jsdom the global URL is not Node's.
const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), "test-isolation-preload.cjs");
const CHILD = "KAOIRO_TEST_ISOLATION_CHILD";
const ROOTS = "KAOIRO_TEST_ISOLATION_ROOTS";
const PERMIT = "KAOIRO_TEST_ISOLATION_PERMIT";
const FOREIGN = "KAOIRO_TEST_ISOLATION_FOREIGN";
const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"];
const POINTERS = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONFIG", "GH_CONFIG_DIR"];
const TOOLS = { systemctl: "systemd", "systemd-run": "systemd", busctl: "systemd", journalctl: "systemd",
  loginctl: "systemd", gh: "gh", docker: "docker" };
const KINDS = new Set(["systemd", "gh", "docker", "network"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const LAUNCHERS = new Set(["env", "setsid", "nohup", "timeout", "nice", "sudo", "xargs"]);
const USER_FLAG = /^--u(?:s(?:e(?:r)?)?)?(?:=|$)/;
const SYSTEMD_TEXT = /(?:systemd-run|systemctl|busctl|journalctl|loginctl)/;
const SHELL_TOOL = /(?:^|[\s;&|()`'"])([^\s;&|()`'"]*\/)?(gh|docker)(?=$|[\s;&|()`'"])/g;

function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

// realpath of the deepest existing ancestor plus the rest, so a missing socket
// or directory inside an owned root is still recognised as owned.
function canonical(path) {
  let head = resolve(path);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...rest);
}

function state() {
  return globalThis[STATE];
}

function ownedPath(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const actual = canonical(path);
  const inside = root => actual === root || actual.startsWith(root + sep);
  return !state().foreign.some(inside) && state().roots.some(inside);
}

function pointerPath(key, value) {
  if (typeof value !== "string") return undefined;
  if (key === "DBUS_SESSION_BUS_ADDRESS") return value.match(/^unix:path=([^,;]+)$/)?.[1];
  if (key === "DOCKER_HOST") return value.match(/^unix:\/\/(\/.+)$/)?.[1];
  return value;
}

function inertPointers() {
  const current = state();
  if (current.inert) return current.inert;
  const base = mkdtempSync(join(tmpdir(), "kaoiro-test-isolation-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const directory = name => { const path = join(base, name); mkdirSync(path, { mode: 0o700 }); return path; };
  current.inert = { DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(base, "no-bus")}`,
    XDG_RUNTIME_DIR: directory("runtime"), DOCKER_HOST: `unix://${join(base, "no-docker.sock")}`,
    DOCKER_CONFIG: directory("docker"), GH_CONFIG_DIR: directory("gh") };
  return current.inert;
}

const PRELOAD_FLAG = `--require="${PRELOAD.replace(/(["\\])/g, "\\$1")}"`;

/** The NODE_OPTIONS value the boundary gives a child whose own NODE_OPTIONS
 *  is empty. */
export function isolationNodeOptions() {
  return PRELOAD_FLAG;
}

function appendPreload(options) {
  return typeof options === "string" && options.includes(PRELOAD_FLAG) ? options
    : `${options ?? ""} ${PRELOAD_FLAG}`.trim();
}

/** The environment a child really receives: the caller's (or the inherited
 *  one), with host pointers that are missing or not owned replaced. */
export function boundaryEnvironment(env) {
  const current = state();
  const result = { ...(env ?? process.env) };
  if (!ownedPath(pointerPath("DOCKER_CONFIG", result.DOCKER_CONFIG))) delete result.DOCKER_CONTEXT;
  for (const key of POINTERS) {
    if (!ownedPath(pointerPath(key, result[key]))) result[key] = inertPointers()[key];
  }
  result.NODE_OPTIONS = appendPreload(result.NODE_OPTIONS);
  result[CHILD] = "1";
  result[ROOTS] = JSON.stringify(current.roots);
  result[FOREIGN] = JSON.stringify(current.foreign);
  if (current.permitted.size > 0) result[PERMIT] = [...current.permitted].join(",");
  else delete result[PERMIT];
  return result;
}

function initialise() {
  const child = process.env[CHILD] === "1";
  const roots = new Set([canonical(tmpdir())]);
  const permitted = new Set();
  const foreign = new Set();
  const handOff = (key, into) => {
    try {
      for (const root of JSON.parse(process.env[key] ?? "[]")) if (typeof root === "string" && isAbsolute(root)) into.add(root);
    } catch { /* an unreadable hand-off is ignored */ }
  };
  if (child) {
    handOff(ROOTS, roots);
    handOff(FOREIGN, foreign);
    for (const kind of (process.env[PERMIT] ?? "").split(",")) if (KINDS.has(kind)) permitted.add(kind);
  }
  globalThis[STATE] = { child, roots: [...roots], foreign: [...foreign], permitted, inert: undefined };
  if (child) return;
  for (const key of [...TOKENS, "DOCKER_CONTEXT"]) delete process.env[key];
  Object.assign(process.env, inertPointers());
}

/** Fixture directories outside the OS temp directory whose programs and
 *  pointers count as owned. */
export function registerOwnedRoot(directory) {
  const root = canonical(directory);
  if (!state().roots.includes(root)) state().roots.push(root);
}

/** Test-only: treat a directory as a host location even inside an owned root,
 *  so stand-in host programs can be placed under the temp directory. It only
 *  narrows ownership. */
export function registerForeignRoot(directory) {
  const root = canonical(directory);
  if (!state().foreign.includes(root)) state().foreign.push(root);
}

/** Relax the listed kinds for this process and its children, only when the
 *  probe's own opt-in variable is "1". Allowed callers are fixed by
 *  scripts/check-test-isolation.mjs. */
export function permitHostAccess({ kinds, optIn, reason }) {
  if (!Array.isArray(kinds) || kinds.some(kind => !KINDS.has(kind)) || typeof optIn !== "string" ||
      typeof reason !== "string" || reason.length === 0) {
    throw new TypeError("permitHostAccess needs known kinds, an opt-in variable and a reason");
  }
  if (process.env[optIn] !== "1") return false;
  for (const kind of kinds) state().permitted.add(kind);
  return true;
}

function program(file, options) {
  if (file.includes("/")) return resolve(options.cwd ?? process.cwd(), file);
  return (options.env?.PATH ?? process.env.PATH ?? "").split(delimiter).filter(Boolean)
    .map(directory => resolve(directory, file)).find(existsSync);
}

// Follows symlinks even when the final target is missing, so a link to a host
// binary is judged by the binary's name and location.
function actualProgram(path) {
  let current = path;
  for (let hops = 0; hops < 40; hops += 1) {
    if (existsSync(current)) return realpathSync(current);
    let link;
    try { link = lstatSync(current).isSymbolicLink() ? readlinkSync(current) : undefined; } catch { link = undefined; }
    if (link === undefined) return canonical(current);
    current = resolve(dirname(current), link);
  }
  return canonical(current);
}

function checkTool(name, path) {
  const kind = TOOLS[name];
  if (!kind || state().permitted.has(kind)) return;
  if (path && ownedPath(path)) return;
  refuse(kind === "systemd" ? "ERR_TEST_HOST_SYSTEMD" : "ERR_TEST_HOST_TOOL",
    `test refused host ${name}: ${path ?? "not found"}`);
}

function shellCommand(command, options = {}) {
  if (!state().permitted.has("systemd") && /kaoiro-runner-update\.sh/.test(command)) {
    refuse("ERR_TEST_HOST_SYSTEMD", "test refused updater in shell command");
  }
  // Shell parsing can hide executable boundaries, so literal names are
  // refused even in benign strings; argv-based owned fixtures still work.
  if (!state().permitted.has("systemd") && SYSTEMD_TEXT.test(command)) {
    refuse("ERR_TEST_HOST_SYSTEMD", "test refused manager in shell command");
  }
  // gh and docker are resolved the way the shell would, through the PATH it
  // receives; a word that resolves to nothing cannot reach a host program.
  for (const [, prefix, tool] of command.matchAll(SHELL_TOOL)) {
    if (state().permitted.has(tool)) continue;
    const path = prefix ? resolve(options.cwd ?? process.cwd(), `${prefix}${tool}`) : program(tool, options);
    if (path && existsSync(path) && !ownedPath(actualProgram(path))) {
      refuse("ERR_TEST_HOST_TOOL", `test refused ${tool} in shell command: ${path}`);
    }
  }
}

function protect(file, args, options) {
  const resolved = program(file, options);
  const actual = resolved && actualProgram(resolved);
  checkTool(basename(file), actual);
  if (actual) checkTool(basename(actual), actual);
  const name = basename(actual ?? file);
  const isUpdater = arg => typeof arg === "string" && basename(arg) === "kaoiro-runner-update.sh";
  const scriptArg = args.find(arg => typeof arg === "string" && !arg.startsWith("-"));
  // Only an executed updater can reach a manager: run directly, as a shell's
  // script argument, or through a launcher. A path merely passed to another
  // program is not a launch.
  const runsUpdater = isUpdater(file) || (SHELLS.has(name) && isUpdater(scriptArg)) ||
    (LAUNCHERS.has(name) && args.some(isUpdater));
  if (runsUpdater && !state().permitted.has("systemd")) {
    const manager = program(options.env?.KAOIRO_SYSTEMCTL ?? process.env.KAOIRO_SYSTEMCTL ?? "systemctl", options);
    if (!manager || !ownedPath(actualProgram(manager))) {
      refuse("ERR_TEST_HOST_SYSTEMD", "test refused updater shell with a host manager");
    }
  }
  if (SHELLS.has(name) || LAUNCHERS.has(name)) {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      if (!state().permitted.has("systemd") && (SYSTEMD_TEXT.test(arg) || USER_FLAG.test(arg))) {
        refuse("ERR_TEST_HOST_SYSTEMD", "test refused manager or user option in shell or launcher arguments");
      }
      checkTool(basename(arg), arg.includes("/") ? arg : program(arg, options));
    }
  }
  const shellIndex = SHELLS.has(name) ? args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) : -1;
  if (shellIndex >= 0) shellCommand(args[shellIndex + 1] ?? "", options);
  if (options.shell) shellCommand([file, ...args].join(" "), options);
}

function invocation(params) {
  const [file, second] = params;
  const hasArgs = Array.isArray(second);
  const index = hasArgs || second == null && params.length > 2 ? 2 : 1;
  const hasOptions = params[index] !== null && typeof params[index] === "object";
  return { file, args: hasArgs ? second : [], options: hasOptions ? params[index] : {},
    rest: params.slice(index + (hasOptions ? 1 : 0)) };
}

function promisified(wrapped) {
  return (...params) => {
    let child;
    const promise = new Promise((resolvePromise, reject) => {
      child = wrapped(...params, (error, stdout, stderr) => error
        ? reject(Object.assign(error, { stdout, stderr })) : resolvePromise({ stdout, stderr }));
    });
    promise.child = child;
    return promise;
  };
}

function installChildProcess() {
  for (const name of ["execFileSync", "spawnSync", "execFile", "spawn", "fork"]) {
    const original = childProcess[name];
    const wrapped = (...params) => {
      const { file, args, rest, options } = invocation(params);
      if (name === "fork") {
        protect(options.execPath ?? process.execPath, [file, ...args], options);
      } else {
        protect(file, args, options);
      }
      return original(file, args, { ...options, env: boundaryEnvironment(options.env) }, ...rest);
    };
    if (original[promisify.custom]) wrapped[promisify.custom] = promisified(wrapped);
    childProcess[name] = wrapped;
  }
  for (const name of ["execSync", "exec"]) {
    const original = childProcess[name];
    const wrapped = (command, options, callback) => {
      if (typeof options === "function") { callback = options; options = {}; }
      shellCommand(command, options ?? {});
      const guarded = { ...(options ?? {}), env: boundaryEnvironment(options?.env) };
      return name === "exec" ? original(command, guarded, callback) : original(command, guarded);
    };
    if (original[promisify.custom]) wrapped[promisify.custom] = promisified(wrapped);
    childProcess[name] = wrapped;
  }
}

function loopback(host) {
  if (host === undefined || host === null || host === "" || host === "localhost") return true;
  const bare = String(host).replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return bare.startsWith("127.");
  if (net.isIPv6(bare)) return bare === "::1" || /^::ffff:127\./i.test(bare);
  return false;
}

function networkError(host) {
  return Object.assign(new Error(`test refused network access to ${host}`), { code: "ERR_TEST_NETWORK" });
}

function installNetwork() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
    if (!state().permitted.has("network") && !options.path && !loopback(options.host)) {
      const error = networkError(options.host);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return connect.apply(this, args);
  };
  for (const method of ["send", "connect"]) {
    const original = dgram.Socket.prototype[method];
    dgram.Socket.prototype[method] = function (...args) {
      const host = args.slice(1).find(arg => typeof arg === "string");
      if (!state().permitted.has("network") && !loopback(host)) throw networkError(host);
      return original.apply(this, args);
    };
  }
  const refusesName = name => !state().permitted.has("network") && !loopback(name);
  for (const target of [dns, dns.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!/^(?:lookup|lookupService|resolve|reverse)/.test(key) || typeof target[key] !== "function") continue;
      const original = target[key];
      target[key] = function (name, ...rest) {
        if (refusesName(name)) {
          const callback = rest.findLast(arg => typeof arg === "function");
          if (!callback) throw networkError(name);
          process.nextTick(() => callback(networkError(name)));
          return undefined;
        }
        return original.call(this, name, ...rest);
      };
    }
  }
  for (const target of [dns.promises, dns.promises.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!/^(?:lookup|lookupService|resolve|reverse)/.test(key) || typeof target[key] !== "function") continue;
      const original = target[key];
      target[key] = function (name, ...rest) {
        return refusesName(name) ? Promise.reject(networkError(name)) : original.call(this, name, ...rest);
      };
    }
  }
}

function installWorker() {
  // A worker loads its own builtins, so the patched child_process and net
  // would not apply inside it.
  workerThreads.Worker = function Worker() {
    refuse("ERR_TEST_ISOLATION", "test refused worker_threads: isolation cannot reach a worker");
  };
}

if (!globalThis[STATE]) {
  initialise();
  installChildProcess();
  installNetwork();
  installWorker();
  syncBuiltinESMExports();
} else if (!state().child) {
  // vitest re-evaluates setup files per test file in one worker; a probe's
  // permission must not carry over to the next file.
  state().permitted.clear();
}
