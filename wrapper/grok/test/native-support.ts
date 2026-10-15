import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost, type GrokHostOptions } from "../src/host.js";
import type { GrokWireMetadata as WireMetadata } from "../src/grok/wire.js";

/** The calls a live test expects Grok to ask about (issue 615): a terminal
 *  command containing `marker`, and the listed kaoiro tools. */
export interface PermissionRule {
  marker?: string;
  tools?: readonly string[];
}
/** One answered permission request: what was asked about, and the answer. */
export interface PermissionDecisionRecord {
  tool: string;
  allow: boolean;
}
/** How a live run answers Grok: by the rule, never, or always deny. */
export interface LivePermissions {
  rule: PermissionRule;
  answer?: "rule" | "none" | "deny";
  decisions?: PermissionDecisionRecord[];
}

/** Runs the real grok with the live-permission plugin (fixtures/grok-live.mjs). */
export const liveExecutable = fileURLToPath(
  new URL("./fixtures/grok-live.mjs", import.meta.url),
);

/** The child variables that configure the plugin's policy for `rule`. */
export function liveEnv(
  rule: PermissionRule,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    KAOIRO_TEST_GROK_ASK_MARKER: rule.marker ?? "",
    KAOIRO_TEST_GROK_ASK_TOOLS: (rule.tools ?? []).join(","),
  };
}

function requestInput(payload: Record<string, unknown>): Record<string, unknown> {
  const input = payload.input;
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** The test's answer under `rule`, the same rule the plugin policy applies. */
export function allowedByRule(
  payload: Record<string, unknown>,
  rule: PermissionRule,
): boolean {
  const input = requestInput(payload);
  if (rule.marker && typeof input.command === "string" && input.command.includes(rule.marker))
    return true;
  return typeof input.tool_name === "string" &&
    (rule.tools ?? []).includes(input.tool_name.replace(/^kaoiro__/, ""));
}

/** Answers a permission_request through the link's real decision callback and
 *  records it; any other envelope is ignored. */
export function answerPermissions(
  envelope: Envelope,
  options: ServerLinkOptions,
  allow: (payload: Record<string, unknown>) => boolean,
  decisions: PermissionDecisionRecord[],
): void {
  if (envelope.type !== "permission_request") return;
  const payload = envelope.payload as Record<string, unknown>;
  const input = requestInput(payload);
  const decision = allow(payload);
  decisions.push({
    tool: typeof input.tool_name === "string"
      ? input.tool_name
      : typeof input.command === "string" ? "run_terminal_command" : "other",
    allow: decision,
  });
  queueMicrotask(() =>
    options.onPermissionDecision?.({
      request_id: String(payload.request_id),
      allow: decision,
    }),
  );
}

export async function nativeRun(
  config: WrapperConfig,
  cwd: string,
  exercise: (
    host: GrokHost,
    options: ServerLinkOptions,
    envelopes: Envelope[],
    metadata: WireMetadata[],
  ) => Promise<void>,
  env?: NodeJS.ProcessEnv,
  // A predicate answers whatever Grok asks, without the plugin (host-dependent).
  permissions?: LivePermissions | ((payload: Record<string, unknown>) => boolean),
  hostOptions?: Pick<GrokHostOptions, "onLaneStep">,
  extras: { argv?: string[]; onSessionId?: (id: string) => void } = {},
) {
  const folder = mkdtempSync(join(tmpdir(), "kaoiro-grok-native-config-"));
  const file = join(folder, "agent.json");
  writeFileSync(file, JSON.stringify(config));
  const previous = process.argv;
  process.argv = [previous[0]!, previous[1]!, file, ...(extras.argv ?? [])];
  const envelopes: Envelope[] = [];
  const metadata: WireMetadata[] = [];
  let callbacks!: ServerLinkOptions;
  let probe!: Promise<void>;
  try {
    const run = runGrokCli({
      cwd,
      onMetadata: (m) => metadata.push(m),
      createServerLink: (_url, _id, options) => {
        callbacks = options;
        queueMicrotask(() => {
          options.permissionSync?.onNegotiated?.(true);
          options.permissionSync?.onSync?.({ version: "0", control: null, next: null }, 1);
          options.onPersonaPrompt?.(
            "Use the requested tools and report only their results.",
          );
        });
        return {
          send: (e: Envelope) => {
            envelopes.push(e);
            if (typeof permissions === "function") {
              answerPermissions(e, options, permissions, []);
              return;
            }
            const answer = permissions?.answer ?? "rule";
            if (answer === "none") return;
            answerPermissions(
              e,
              options,
              (payload) =>
                answer === "rule" &&
                permissions !== undefined &&
                allowedByRule(payload, permissions.rule),
              permissions?.decisions ?? [],
            );
          },
          setSessionId: (id: string) => extras.onSessionId?.(id),
          waitForPermissionSyncNegotiation: async () => true,
          waitForPermissionSync: async () => {},
          reportPermissionLifecycle: () => {},
          noticeAttributionMode: () => "legacy",
          reportDisconnectIntent: async () => {},
          close: () => {},
          deliveryIncarnation: () => null,
          deliveryGeneration: () => null,
          requestDirectory: async () => ({ agents: [], users: [] }),
        } as unknown as ServerLink;
      },
      ...(env || hostOptions || permissions
        ? {
            createHost: (options: ConstructorParameters<typeof GrokHost>[0]) =>
              new GrokHost({
                ...options,
                ...(env ? { env } : {}),
                ...(permissions && typeof permissions !== "function"
                  ? { executable: liveExecutable, env: liveEnv(permissions.rule, env) }
                  : {}),
                ...hostOptions,
              }),
          }
        : {}),
      onHostCreated: (host) => {
        probe = exercise(host, callbacks, envelopes, metadata).finally(() =>
          host.close(),
        );
        void probe.catch(() => host.close());
      },
    });
    await run;
    await probe;
  } finally {
    process.argv = previous;
    rmSync(folder, { recursive: true, force: true });
  }
}
