import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  askUserQuestionDescriptor,
  classifyInterAgentError,
  createDeliveryAcknowledgementRuntime,
  formatInboundMessage,
  InterAgentTool,
  makeLog,
  mergePendingDisplayNameSync,
  PermissionBroker,
  QuestionBroker,
  writeRedactedStderr,
  type Envelope,
  type ToolDescriptor,
  type WhoamiSnapshot,
} from "@kaoiro/agent-common";
import {
  loadConfig,
  loadWrapperBuildInfo,
  parseCliArgs,
  ServerLink,
} from "@kaoiro/wrapper-core";
import { GrokHost, type GrokHostOptions } from "./host.js";
import type { GrokWireMetadata } from "./grok/wire.js";
import { GrokLaunchError } from "./grok/errors.js";

export interface GrokCliDependencies {
  parseCliArgs?: typeof parseCliArgs;
  loadConfig?: typeof loadConfig;
  loadWrapperBuildInfo?: typeof loadWrapperBuildInfo;
  createServerLink?: (
    ...args: ConstructorParameters<typeof ServerLink>
  ) => ServerLink;
  createHost?: (options: GrokHostOptions) => GrokHost;
  onHostCreated?: (host: GrokHost) => void;
  onMetadata?: (metadata: GrokWireMetadata) => void;
  additionalTools?: ToolDescriptor[];
  cwd?: string;
}

export async function runGrokCli(dependencies: GrokCliDependencies = {}) {
  const args = (dependencies.parseCliArgs ?? parseCliArgs)(
    process.argv.slice(2),
  );
  if (args.resume) throw new Error("grok resume is unsupported in work unit 1");
  const config = (dependencies.loadConfig ?? loadConfig)(args.configPath);
  const buildInfo = (dependencies.loadWrapperBuildInfo ?? loadWrapperBuildInfo)(
    fileURLToPath(new URL("../dist/build-info.json", import.meta.url)),
  );
  let host: GrokHost | undefined;
  let link: ServerLink | undefined;
  let pendingName: { displayName: string; revision: number } | undefined;
  let chain: Promise<void> = Promise.resolve();
  let ready!: () => void;
  const hostReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const deliveries = new Map<string, Envelope[]>();
  const send = (envelope: Envelope) => link?.send(envelope);
  const permission = new PermissionBroker({
    config,
    send,
    onPendingChange: (pending) => host?.setPendingPermission(pending),
  });
  const question = new QuestionBroker({
    config,
    send,
    onPendingChange: (pending) => host?.setPendingQuestion(pending),
  });
  const turns = {
    deliverySequencesForTurn: (token: string) =>
      (deliveries.get(token) ?? []).flatMap((envelope) => {
        const seq = (envelope as Envelope & { delivery_seq?: number })
          .delivery_seq;
        return seq === undefined ? [] : [seq];
      }),
    deliveryEnvelopesForTurn: (token: string) => deliveries.get(token) ?? [],
  };
  const acknowledgements = createDeliveryAcknowledgementRuntime(
    (seq) => link?.acknowledgeInterAgentDelivery(seq),
    turns,
    () => {
      const incarnation = link?.deliveryIncarnation();
      const generation = link?.deliveryGeneration();
      return incarnation && generation ? { incarnation, generation } : null;
    },
  );
  const interAgent = new InterAgentTool({
    config,
    send,
    getState: () => host?.state ?? "idle",
    getActiveInterAgentTurnToken: () =>
      host?.activeInterAgentTurnToken() ?? null,
    noticeAttributionMode: () => link?.noticeAttributionMode() ?? "pending",
    sendInterAgent: (envelope) =>
      link?.sendInterAgent(envelope) ??
      Promise.resolve({ kind: "unknown", reason: "not_connected" }),
    requestDirectory: () =>
      link?.requestDirectory() ?? Promise.resolve({ agents: [], users: [] }),
    setStatusLine: (text) =>
      link?.setStatusLine(text) ??
      Promise.resolve({ kind: "error", reason: "not_connected" }),
    readStatusLine: (id) =>
      link?.readStatusLine(id) ??
      Promise.resolve({ kind: "error", reason: "not_connected" }),
    requestInterAgentDeliveryStatus: () =>
      link?.requestInterAgentDeliveryStatus() ?? Promise.resolve(null),
    getWhoami: () =>
      ({
        agent_id: config.agent_id,
        persona: config.persona,
        state: host?.state ?? "idle",
        ...(host?.statusSnapshot() ?? { engine: "grok" }),
        build: buildInfo,
      }) as WhoamiSnapshot,
  });
  let resolvePersona!: (text: string) => void;
  const persona = new Promise<string>((resolve) => {
    resolvePersona = resolve;
  });
  const controlFailure = (operation: string) => {
    send(
      makeLog(config, host?.state ?? "idle", new Date().toISOString(), {
        kind: "system",
        text: `grok ${operation} is unsupported in work unit 1`,
      }),
    );
  };
  const turnFailure = () => send(makeLog(
    config, host?.state ?? "idle", new Date().toISOString(),
    { kind: "system", text: "grok turn failed" },
  ));
  const options = acknowledgements.withServerLinkOptions({
    personaId: config.persona.id,
    ...(config.server_token ? { token: config.server_token } : {}),
    ...(config.transition_id ? { transitionId: config.transition_id } : {}),
    buildInfo,
    noticeAttribution: "v1" as const,
    interAgentDeliveryModes: {
      version: "v1" as const,
      early: "none" as const,
      yield: "none" as const,
      stage_reports: false,
    },
    onPersonaPrompt: resolvePersona,
    onInstruction: (text: string, attachments?: string[]) => {
      chain = chain
        .then(async () => {
          await hostReady;
          await host!.send(text, attachments);
        })
        .catch(() => {
          if (attachments?.length) controlFailure("attachment input");
          else turnFailure();
        });
    },
    onPermissionDecision: (
      decision: Parameters<PermissionBroker["resolve"]>[0],
    ) => permission.resolve(decision),
    onQuestionResponse: (answer: Parameters<QuestionBroker["resolve"]>[0]) =>
      question.resolve(answer),
    onInterrupt: () => {
      void host?.interrupt().catch(() => host?.close());
    },
    onSetModel: () => controlFailure("model switching"),
    onSetEffort: () => controlFailure("effort switching"),
    onSetPermission: () => controlFailure("permission switching"),
    onSetPermissionMode: () => controlFailure("permission mode switching"),
    onDisplayNameSync: (name: string, revision: number) => {
      if (host) host.renameDisplayName(name, revision);
      else
        pendingName = mergePendingDisplayNameSync(pendingName, name, revision);
    },
    onInterAgentMessage: (envelope: Envelope) => {
      acknowledgements.captureDelivery(envelope);
      chain = chain
        .then(async () => {
          await hostReady;
          const disposition = await interAgent.receiveInbound(envelope);
          if (disposition.consumed || !disposition.inject) {
            if (!(disposition.consumed && disposition.deferAck)) {
              acknowledgements.acknowledgeDelivery(envelope);
            }
            if (disposition.notice) send(disposition.notice);
            return;
          }
          const token = randomUUID();
          const id = String(envelope.payload.conversation_id);
          deliveries.set(token, [envelope]);
          interAgent.notePendingInjection(envelope, token);
          try {
            await host!.send(
              formatInboundMessage(envelope, { mode: disposition.mode }),
              undefined,
              [id],
              token,
            );
          } catch {
            for (const notice of interAgent.resolveTurnEnd(
              token,
              [id],
              classifyInterAgentError({ detail: "grok turn failed" }),
            ))
              send(notice);
          } finally {
            deliveries.delete(token);
          }
        })
        .catch(() => {
          turnFailure();
        });
    },
  });
  const createLink =
    dependencies.createServerLink ??
    ((...values: ConstructorParameters<typeof ServerLink>) =>
      new ServerLink(...values));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => host?.close();
  let disconnectReason: "stop" | "crash" = "stop";
  try {
    link = createLink(config.server_url, config.agent_id, options);
    const rules = await Promise.race([
      persona,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("grok persona prompt timed out")),
          10_000,
        );
      }),
    ]);
    clearTimeout(timer);
    host = (dependencies.createHost ?? ((opts) => new GrokHost(opts)))(
      acknowledgements.withHostOptions({
        config,
        cwd: dependencies.cwd ?? process.cwd(),
        personaPrompt: rules,
        send,
        toolDescriptors: [
          ...interAgent.descriptors(),
          askUserQuestionDescriptor((questions) => question.decide(questions)),
          ...(dependencies.additionalTools ?? []),
        ],
        decidePermission: (
          name: string,
          input: Record<string, unknown>,
          signal?: AbortSignal,
        ) => permission.decide(name, input, signal),
        onSessionId: (id: string) => link?.setSessionId(id),
        onMetadata: (metadata: GrokWireMetadata) => {
          writeRedactedStderr(
            `[kaoiro] grok ACP ${JSON.stringify(metadata)}\n`,
          );
          dependencies.onMetadata?.(metadata);
        },
        onTurnEnd: ({
          turnToken,
          conversationIds,
          error,
        }: {
          turnToken: string;
          conversationIds: string[];
          error?: { detail: string };
        }) => {
          question.close();
          for (const notice of interAgent.resolveTurnEnd(
            turnToken,
            conversationIds,
            error ? classifyInterAgentError(error) : undefined,
          ))
            send(notice);
        },
      }),
    );
    if (pendingName)
      host.renameDisplayName(pendingName.displayName, pendingName.revision);
    ready();
    dependencies.onHostCreated?.(host);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await host.run(args.prompt);
  } catch (error) {
    disconnectReason = "crash";
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    question.close();
    permission.close();
    host?.close();
    await host?.closed;
    try {
      await link?.reportDisconnectIntent(disconnectReason);
    } finally {
      link?.close();
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runGrokCli().catch((error: unknown) => {
    const detail =
      error instanceof GrokLaunchError ? error.message : "grok wrapper failed";
    writeRedactedStderr(`[kaoiro] ${detail}\n`);
    process.exitCode = 1;
  });
}
