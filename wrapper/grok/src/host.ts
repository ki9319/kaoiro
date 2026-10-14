import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import {
  initialMachineState,
  makeLog,
  makeResult,
  makeStateChange,
  stepState,
  writeRedactedStderr,
  type AdapterEvent,
  type EngineAdapter,
  type Envelope,
  type MachineState,
  type PendingPermissionExt,
  type PendingQuestionExt,
  type PermissionMode,
  type PermissionSelection,
  type ToolDescriptor,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { AcpSession } from "./acp/session.js";
import { connectAcp } from "./acp/connection.js";
import { GrokProcess } from "./grok/process.js";
import {
  cancellationKind,
  promptIdOf,
  turnCompletion,
  updateEvents,
} from "./grok/events.js";
import {
  grokExtension,
  grokSessionMeta,
  type GrokWireMetadata,
} from "./grok/wire.js";
import {
  childEnvironment,
  inspectPolicy,
  sandboxProfile,
  type PermissionPolicyExt,
} from "./grok/policy.js";
import { formatTurnWatchdogLine } from "@kaoiro/wrapper-core";
import { resolveTurnWatchdogSettings } from "./settings.js";
import { GrokLaunchError } from "./grok/errors.js";
import { ToolHost } from "./toolhost.js";

export interface GrokHostOptions {
  config: WrapperConfig;
  cwd: string;
  personaPrompt: string;
  send: (envelope: Envelope) => void;
  toolDescriptors?: ToolDescriptor[];
  decidePermission: (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ allow: boolean }>;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  onSessionId?: (id: string) => void;
  onMetadata?: (metadata: GrokWireMetadata) => void;
  onTurnStart?: (turn: { turnToken: string }) => void;
  onTurnEnd?: (turn: {
    turnToken: string;
    conversationIds: string[];
    error?: { detail: string };
  }) => void;
}
interface Turn {
  text: string;
  token: string;
  conversations: string[];
  resolve: () => void;
  reject: (error: Error) => void;
}

export class GrokHost implements EngineAdapter {
  #machine: MachineState = initialMachineState();
  #toolHost: ToolHost | undefined;
  #process: GrokProcess | undefined;
  #session: AcpSession | undefined;
  #policy: PermissionPolicyExt | undefined;
  #queue: Turn[] = [];
  #active: Turn | undefined;
  #signal: AbortController | undefined;
  #started = false;
  #closing = false;
  #revision = 0;
  #failure: Error | undefined;
  #completion: { sessionId: string; promptId: string } | undefined;
  readonly #lifetime = new AbortController();
  #starting = false;
  #finishStartup!: () => void;
  readonly #startupFinished = new Promise<void>((resolve) => {
    this.#finishStartup = resolve;
  });
  #pendingPermission: PendingPermissionExt | null = null;
  #pendingQuestion: PendingQuestionExt | null = null;
  #text = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #abortTimer: ReturnType<typeof setTimeout> | undefined;
  #resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  readonly #options: GrokHostOptions;
  readonly #settings;

  constructor(options: GrokHostOptions) {
    this.#options = options;
    const resolved = resolveTurnWatchdogSettings(
      options.env ?? process.env,
      writeRedactedStderr,
      options.config,
    );
    this.#settings = resolved.settings;
    writeRedactedStderr(formatTurnWatchdogLine(
      "grok", process.pid, resolved, options.config.permission_timeout_ms,
    ));
  }

  get state() {
    return this.#machine.state;
  }
  get processId() {
    return this.#process?.child.pid;
  }
  activeInterAgentTurnToken() {
    return this.#active?.token ?? null;
  }
  statusExtSnapshot(): Record<string, unknown> {
    const profile = this.#policy?.grok_sandbox_env;
    const sandbox = this.#options.config.sandbox ?? "workspace-write";
    const network =
      this.#options.config.network_access ?? sandbox !== "read-only";
    return {
      engine: "grok",
      models: [{ value: "default", display_name: "Account default" }],
      model: "default",
      model_source: "default",
      ...(profile
        ? {
            permission: {
              sandbox,
              approval: "on-request",
              ...(profile === "off" ? {} : { enforcement: "os" }),
            },
            permission_policy: this.#policy,
            effective: { sandbox, network_access: network },
          }
        : {}),
      session_capabilities: {
        supports_model_switch: false,
        supports_effort_switch: false,
        supports_permission_switch: false,
        supports_permission_mode_switch: false,
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_session_reset: false,
        supports_context_usage: false,
        permission_switch_axes: {},
      },
      delivery_modes: { early: "none", yield: "none" },
      ...(this.#pendingPermission
        ? { pending_permission: this.#pendingPermission }
        : {}),
      ...(this.#pendingQuestion
        ? { pending_question: this.#pendingQuestion }
        : {}),
    };
  }
  statusSnapshot() {
    const ext = this.statusExtSnapshot();
    return {
      engine: "grok",
      model: "default",
      model_source: "default",
      ...(ext.permission ? { permission: ext.permission } : {}),
    };
  }
  #state(state: MachineState["state"]) {
    this.#machine = { ...this.#machine, state };
    this.#options.send(
      makeStateChange(
        this.#options.config,
        state,
        new Date().toISOString(),
        {},
        this.statusExtSnapshot(),
      ),
    );
  }
  #event(event: AdapterEvent) {
    if (event.kind === "assistant" && this.#machine.pendingToolUses.size > 0) {
      event = {
        ...event,
        blocks: [...event.blocks, "tool_use"],
        toolUseIds: [
          ...new Set([
            ...this.#machine.pendingToolUses,
            ...(event.toolUseIds ?? []),
          ]),
        ],
      };
    }
    const { next, emitted } = stepState(this.#machine, event);
    this.#machine = next;
    for (const state of emitted) {
      this.#state(
        this.#pendingPermission
          ? "waiting_permission"
          : this.#pendingQuestion
            ? "waiting_question"
            : state,
      );
    }
  }

  async run(prompt?: string): Promise<void> {
    if (this.#started || this.#starting || this.#closing) {
      throw new Error("grok host already started");
    }
    const config = this.#options.config;
    if (config.model && config.model !== "default") {
      throw new Error(
        "grok work unit 1 supports only the account default model",
      );
    }
    if (config.effort) throw new Error("grok effort selection is unsupported");
    if (config.permission_mode)
      throw new Error("grok permission mode is unsupported");
    try {
      this.#starting = true;
      try {
        const inherited = this.#options.env ?? process.env;
        const profile = sandboxProfile(config, this.#options.cwd, inherited);
        const env = childEnvironment(inherited, profile);
        const executable = this.#options.executable ?? "grok";
        this.#policy = await inspectPolicy(
          executable,
          this.#options.cwd,
          env,
          profile,
          this.#lifetime.signal,
        );
        if (this.#closing) return;
        this.#toolHost = await ToolHost.listen(
          this.#options.toolDescriptors ?? [],
          { turnSignal: () => this.#signal?.signal ?? null },
        );
        if (this.#closing) {
          this.#toolHost.close();
          this.#toolHost = undefined;
          return;
        }
        this.#process = new GrokProcess(executable, this.#options.cwd, env);
        const connection = connectAcp<GrokWireMetadata>(
          this.#process.child,
          {
            update: (notification) => this.#update(notification),
            permission: (request, signal) => this.#permission(request, signal),
            metadata: (metadata) => this.#options.onMetadata?.(metadata),
          },
          grokExtension((notification) => this.#vendor(notification)),
        );
        this.#session = new AcpSession(connection);
        void connection.closed.then(() => {
          if (!this.#closing) {
            this.#failure = new Error(
              "grok ACP connection closed unexpectedly",
            );
            this.close();
          }
        });
        const failed = this.#process.exited.then(() => {
          throw new Error("grok child exited before session initialization");
        });
        await Promise.race([
          this.#session.open(
            this.#options.cwd,
            [
              {
                name: "kaoiro",
                command: process.execPath,
                args: [
                  fileURLToPath(new URL("../dist/bridge.js", import.meta.url)),
                ],
                env: [
                  {
                    name: "KAOIRO_BRIDGE_SOCKET",
                    value: this.#toolHost.socketPath,
                  },
                ],
              },
            ],
            grokSessionMeta(this.#options.personaPrompt),
          ),
          failed,
          new Promise<never>((_, reject) => {
            this.#timer = setTimeout(
              () => reject(new Error("grok startup timed out")),
              30_000,
            );
          }),
        ]);
        clearTimeout(this.#timer);
        if (this.#closing) return;
        this.#started = true;
        this.#options.onSessionId?.(this.#session.sessionId!);
        this.#state("waiting_input");
        void this.#process.exited
          .then(() => {
            if (!this.#closing) {
              this.#failure = new Error("grok child exited unexpectedly");
              this.close();
            }
          })
          .catch(() => this.close());
        if (prompt !== undefined) void this.send(prompt).catch(() => {});
        void this.#drain();
      } finally {
        this.#starting = false;
        this.#finishStartup();
      }
      await this.closed;
      if (this.#failure) throw this.#failure;
    } catch (error) {
      const stopping = this.#closing && !this.#failure;
      if (!stopping) this.#state("error");
      if (error instanceof GrokLaunchError) {
        this.#options.send(makeLog(
          config, this.state, new Date().toISOString(),
          { kind: "system", text: error.message },
        ));
      }
      this.close();
      await this.closed;
      if (!stopping) throw error;
    }
  }

  send(
    text: string,
    attachmentIds?: string[],
    conversations: string[] = [],
    token: string = randomUUID(),
  ): Promise<void> {
    if (attachmentIds?.length)
      return Promise.reject(new Error("grok attachments are unsupported"));
    if (this.#closing) return Promise.reject(new Error("grok host is closed"));
    const promise = new Promise<void>((resolve, reject) => {
      this.#queue.push({ text, token, conversations, resolve, reject });
    });
    if (this.#started) void this.#drain();
    return promise;
  }

  async #drain() {
    if (this.#active || !this.#started || this.#closing) return;
    const turn = this.#queue.shift();
    if (!turn) return;
    this.#active = turn;
    this.#signal = new AbortController();
    this.#text = "";
    this.#event({ kind: "user_send" });
    this.#options.send(
      makeLog(this.#options.config, this.state, new Date().toISOString(), {
        kind: "user",
        text: turn.text,
      }),
    );
    this.#options.onTurnStart?.({ turnToken: turn.token });
    this.#progress();
    let error: Error | undefined;
    let permissionRejected = false;
    try {
      const response = await this.#session!.prompt(turn.text);
      const completed =
        this.#completion?.sessionId === this.#session?.sessionId &&
        this.#completion?.promptId === promptIdOf(response._meta);
      const rejected =
        response.stopReason === "cancelled" &&
        cancellationKind(response._meta) === "rejected";
      permissionRejected = rejected;
      if (rejected) throw new Error("grok permission rejected");
      const interrupted = response.stopReason === "cancelled" && !rejected;
      this.#event({
        kind: "result",
        subtype: rejected ? "error_during_execution" : "success",
      });
      this.#options.send(
        makeResult(
          this.#options.config,
          new Date().toISOString(),
          {
            text: this.#text,
            is_error: rejected,
            ...(rejected ? { error_code: "permission_rejected" } : {}),
          },
          {
            stop_reason: response.stopReason,
            completion_source: completed ? "vendor" : "prompt_response",
            ...(interrupted ? { interrupted: true } : {}),
          },
        ),
      );
      turn.resolve();
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("grok turn failed");
      this.#event({ kind: "result", subtype: "error_during_execution" });
      this.#options.send(
        makeResult(this.#options.config, new Date().toISOString(), {
          text: "",
          is_error: true,
          error_code: permissionRejected
            ? "permission_rejected"
            : "grok_turn_failed",
        }),
      );
      turn.reject(error);
    } finally {
      clearTimeout(this.#timer);
      clearTimeout(this.#abortTimer);
      this.#signal?.abort();
      this.#signal = undefined;
      this.#active = undefined;
      this.#options.onTurnEnd?.({
        turnToken: turn.token,
        conversationIds: turn.conversations,
        ...(error ? { error: { detail: "grok turn failed" } } : {}),
      });
      if (!this.#closing) this.#state("waiting_input");
      void this.#drain();
    }
  }

  #progress() {
    clearTimeout(this.#timer);
    if (
      !this.#active ||
      this.#closing ||
      this.#pendingPermission ||
      this.#pendingQuestion
    )
      return;
    this.#timer = setTimeout(() => {
      this.close();
    }, this.#settings.inactivityMs);
  }
  #update(notification: acp.SessionNotification) {
    if (!this.#active || notification.sessionId !== this.#session?.sessionId)
      return;
    this.#progress();
    const update = updateEvents(notification);
    for (const event of update.events) this.#event(event);
    if (update.text) this.#text += update.text;
    if (update.log)
      this.#options.send(
        makeLog(
          this.#options.config,
          this.state,
          new Date().toISOString(),
          update.log,
        ),
      );
  }
  #vendor(notification: Record<string, unknown>) {
    const completion = turnCompletion(notification, this.#session?.sessionId);
    if (completion) this.#completion = completion;
  }
  async #permission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    if (!this.#active || request.sessionId !== this.#session?.sessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const alive = AbortSignal.any([signal, this.#signal!.signal]);
    const raw = request.toolCall.rawInput;
    const input =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const decision = await this.#options.decidePermission(
      request.toolCall.title ?? "grok tool",
      { ...input, tool_call_id: request.toolCall.toolCallId },
      alive,
    );
    const kind = decision.allow ? "allow_once" : "reject_once";
    const option = request.options.find((o) => o.kind === kind);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  async interrupt() {
    if (!this.#active) return;
    this.#abortTimer = setTimeout(
      () => this.close(),
      Math.min(this.#settings.abortGraceMs, 3_000),
    );
    await this.#session?.cancel();
  }
  close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#lifetime.abort();
    clearTimeout(this.#timer);
    clearTimeout(this.#abortTimer);
    this.#signal?.abort();
    for (const turn of this.#queue.splice(0)) {
      turn.reject(new Error("grok host is closed"));
      this.#options.onTurnEnd?.({
        turnToken: turn.token,
        conversationIds: turn.conversations,
        error: { detail: "grok host closed" },
      });
    }
    this.#toolHost?.close();
    this.#toolHost = undefined;
    this.#session?.connection.close();
    void (async () => {
      if (this.#starting) await this.#startupFinished;
      await this.#process?.close();
    })().finally(() => this.#resolveClosed());
  }
  async setModel(_value: string) {
    throw new Error("grok model switching is unsupported");
  }
  async setEffort(_value: string) {
    throw new Error("grok effort switching is unsupported");
  }
  async setPermission(_value: PermissionSelection) {
    throw new Error("grok permissions are fixed at spawn");
  }
  async setPermissionMode(_value: PermissionMode) {
    throw new Error("grok permission mode is unsupported");
  }
  setPendingPermission(pending: PendingPermissionExt | null) {
    this.#pendingPermission = pending;
    if (pending) {
      clearTimeout(this.#timer);
      this.#event({ kind: "permission_request" });
    } else if (this.#active) {
      this.#event({ kind: "permission_resolved" });
      this.#progress();
    }
  }
  setPendingQuestion(pending: PendingQuestionExt | null) {
    this.#pendingQuestion = pending;
    if (pending) {
      clearTimeout(this.#timer);
      this.#event({ kind: "question_request" });
    } else if (this.#active) {
      this.#event({ kind: "question_resolved" });
      this.#progress();
    }
  }
  renameDisplayName(name: string, revision: number) {
    if (revision <= this.#revision) return;
    this.#revision = revision;
    this.#options.config.display_name = name;
    this.#state(this.state);
  }
}
