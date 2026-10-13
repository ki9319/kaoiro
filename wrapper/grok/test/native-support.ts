import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import type { WireMetadata } from "../src/acp/connection.js";
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
  allowPermission?: (input: Record<string, unknown>) => boolean,
) {
  const folder = mkdtempSync(join(tmpdir(), "kaoiro-grok-native-config-"));
  const file = join(folder, "agent.json");
  writeFileSync(file, JSON.stringify(config));
  const previous = process.argv;
  process.argv = [previous[0]!, previous[1]!, file];
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
        queueMicrotask(() =>
          options.onPersonaPrompt?.(
            "Use the requested tools and report only their results.",
          ),
        );
        return {
          send: (e: Envelope) => {
            envelopes.push(e);
            if (e.type === "permission_request")
              queueMicrotask(() =>
                options.onPermissionDecision?.({
                  request_id: String(e.payload.request_id),
                  allow: allowPermission?.(e.payload) ?? false,
                }),
              );
          },
          setSessionId: () => {},
          noticeAttributionMode: () => "legacy",
          reportDisconnectIntent: async () => {},
          close: () => {},
          deliveryIncarnation: () => null,
          deliveryGeneration: () => null,
          requestDirectory: async () => ({ agents: [], users: [] }),
        } as unknown as ServerLink;
      },
      ...(env
        ? {
            createHost: (options: ConstructorParameters<typeof GrokHost>[0]) =>
              new GrokHost({ ...options, env }),
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
