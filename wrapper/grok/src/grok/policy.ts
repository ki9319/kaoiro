import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { WrapperConfig } from "@kaoiro/protocol";
import { GrokLaunchError } from "./errors.js";

export type SandboxProfile = "read-only" | "workspace" | "off";
export interface PermissionPolicyCommon {
  grok_sandbox_env: SandboxProfile;
  grok_version: string | null;
}
export type PermissionPolicyExt = PermissionPolicyCommon &
  (
    | { inspect: "unavailable" }
    | {
        inspect: "ok";
        sources: string[];
        managed_settings_active: boolean;
        rules_loaded: number;
        rules_skipped: number;
        claude_hooks: { enabled: boolean; source: string };
      }
  );

function within(root: string, cwd: string): boolean {
  const path = relative(root, cwd);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export function sandboxProfile(
  config: Pick<WrapperConfig, "sandbox" | "network_access" | "approval">,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): SandboxProfile {
  const sandbox = config.sandbox ?? "workspace-write";
  const network = config.network_access ?? sandbox !== "read-only";
  if (config.approval !== undefined && config.approval !== "on-request") {
    throw new GrokLaunchError("grok approval is fixed at on-request");
  }
  if (sandbox === "danger-full-access" && network) return "off";
  if (platform !== "linux") {
    throw new GrokLaunchError(
      "grok OS sandbox profiles require Linux in work unit 1",
    );
  }
  if (sandbox === "workspace-write" && network) return "workspace";
  if (sandbox === "read-only" && !network) {
    const canonical = realpathSync(cwd);
    const home = env.GROK_HOME ?? join(env.HOME ?? homedir(), ".grok");
    for (const root of ["/tmp", "/var/tmp", home]) {
      let path: string;
      try {
        path = realpathSync(root);
      } catch {
        path = root;
      }
      if (within(path, canonical)) {
        throw new GrokLaunchError(
          "grok read-only cwd is in an always-writable directory",
        );
      }
    }
    return "read-only";
  }
  throw new GrokLaunchError("unsupported grok sandbox/network pair");
}

export function childEnvironment(
  inherited: NodeJS.ProcessEnv,
  profile: SandboxProfile,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, GROK_SANDBOX: profile };
  for (const key of Object.keys(env)) {
    if (/^GROK_CLAUDE_.*_ENABLED$/.test(key)) delete env[key];
  }
  return env;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePermissionPolicy(
  raw: unknown,
  common: PermissionPolicyCommon,
): PermissionPolicyExt {
  const unknown: PermissionPolicyExt = { ...common, inspect: "unavailable" };
  if (!object(raw) || !object(raw.permissions) || !object(raw.externalCompat)) {
    return unknown;
  }
  const p = raw.permissions;
  const cells = raw.externalCompat.cells;
  if (
    !Array.isArray(p.sources) ||
    !p.sources.every((s) => typeof s === "string") ||
    !Number.isSafeInteger(p.loaded) ||
    (p.loaded as number) < 0 ||
    !Array.isArray(p.skipped) ||
    !p.skipped.every(
      (s) =>
        object(s) && typeof s.rule === "string" && typeof s.reason === "string",
    ) ||
    typeof p.managedSettingsActive !== "boolean" ||
    !Array.isArray(cells)
  ) {
    return unknown;
  }
  const hooks = cells.filter(
    (c) => object(c) && c.vendor === "claude" && c.surface === "hooks",
  );
  if (
    hooks.length !== 1 ||
    typeof hooks[0].enabled !== "boolean" ||
    typeof hooks[0].source !== "string"
  )
    return unknown;
  return {
    ...common,
    inspect: "ok",
    sources: [...p.sources],
    managed_settings_active: p.managedSettingsActive,
    rules_loaded: p.loaded as number,
    rules_skipped: p.skipped.length,
    claude_hooks: { enabled: hooks[0].enabled, source: hooks[0].source },
  };
}

function command(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd,
        env,
        ...(signal ? { signal } : {}),
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        resolve(error ? null : stdout.trim());
      },
    );
  });
}

export async function inspectPolicy(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  profile: SandboxProfile,
  signal?: AbortSignal,
): Promise<PermissionPolicyExt> {
  const [version, output] = await Promise.all([
    command(executable, ["--no-auto-update", "--version"], cwd, env, signal),
    command(
      executable,
      ["--no-auto-update", "inspect", "--json"],
      cwd,
      env,
      signal,
    ),
  ]);
  const common = { grok_sandbox_env: profile, grok_version: version };
  try {
    return parsePermissionPolicy(JSON.parse(output ?? "null"), common);
  } catch {
    return { ...common, inspect: "unavailable" };
  }
}
