import { randomUUID } from "node:crypto";
import type { PermissionSelection as Selection, PermissionSubmission, PermissionSyncMessage,
  PermissionGateExt, WrapperPermissionLifecycleMessage } from "@kaoiro/protocol";
import { createPermissionState, setPermissionSyncSupport, requestPermission,
  applyPermissionSyncState, capturePermission, beginPermissionExecution,
  permissionLaneFailed, permissionObservationApplied, permissionObservationFailed,
  withinCeiling, effectiveNetworkAccess, type PermissionState } from "./permission_state.js";
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
  type SandboxProfile,
} from "./grok/policy.js";
import { formatTurnWatchdogLine } from "@kaoiro/wrapper-core";
import { resolveTurnWatchdogSettings } from "./settings.js";
import { GrokLaunchError } from "./grok/errors.js";
import { MCP_NOT_CONNECTED, ToolHost, type ToolHostStats } from "./toolhost.js";

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
  /** How long to wait, after the session exists, for Grok to list the kaoiro
   *  tools. Startup fails with the reason when it does not. */
  mcpReadyTimeoutMs?: number;
  platform?: NodeJS.Platform;
  permissionSyncSupported?: boolean;
  waitForPermissionSync?: () => Promise<void>;
  permissionGateTimeoutMs?: number;
  onPermissionLifecycle?: (event: WrapperPermissionLifecycleMessage) => void;
  /** A synchronization seam for lifecycle tests; production has no observer. */
  onLaneStep?: (step: LaneStep, pid?: number) => Promise<void> | void;
  onSessionId?: (id: string) => void;
  onMetadata?: (metadata: GrokWireMetadata) => void;
  onTurnStart?: (turn: { turnToken: string }) => void;
  onTurnEnd?: (turn: {
    turnToken: string;
    conversationIds: string[];
    error?: { detail: string; reason?: string };
  }) => void;
}
/** Grok connects to the MCP server within about a second of session/new
 *  (measured at most 1.1 s); this is far past that and inside the 30 s startup
 *  deadline, so a missing connection reports its own reason first. */
const MCP_READY_TIMEOUT_MS = 15_000;
type LaneStep = "stopping" | "inspect" | "spawn" | "initialize" | "load" | "readiness" | "promotion";
interface Generation {
  role: "current" | "loading" | "retired";
  process: GrokProcess;
  session: AcpSession;
  toolHost: ToolHost;
  profile: SandboxProfile;
  policy: PermissionPolicyExt;
  failure?: Error;
  failed: Promise<never>;
  fail: (error: Error) => void;
}
class LaneFailure extends Error {
  constructor(readonly step: PermissionGateExt["step"] | "stopping") { super("grok restart failed"); }
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
  #current: Generation | undefined;
  #loading: Generation | undefined;
  #sessionId: string | undefined;
  #lane: Promise<void> = Promise.resolve();
  #draining = false;
  #wake: (() => void) | undefined;
  #permissions: PermissionState;
  readonly #ceiling: Selection;
  readonly #platform: NodeJS.Platform;
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
    this.#platform = options.platform ?? process.platform;
    const sandbox = options.config.sandbox ?? "workspace-write";
    this.#ceiling = { revision: 0, requested: { sandbox,
      network_access: options.config.network_access ?? sandbox !== "read-only" } };
    this.#permissions = createPermissionState(this.#ceiling,
      this.#platform === "linux" && options.permissionSyncSupported === true);
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
    return this.#current?.process.child.pid;
  }
  /** For tests: what the tool server has seen. It never holds the token. */
  toolHostStats(): ToolHostStats | undefined {
    return this.#current?.toolHost.stats();
  }
  activeInterAgentTurnToken() {
    return this.#active?.token ?? null;
  }
  statusExtSnapshot(): Record<string, unknown> {
    const profile = this.#current?.profile;
    const observed = this.#permissions.current?.observation;
    const projectProfile = !this.#permissions.latest || !this.#permissions.lastEffective;
    const pair = this.#ceiling.requested;
    const projectedSandbox = profile === "off" ? "danger-full-access" : profile === "workspace" ? "workspace-write" : "read-only";
    const permission = observed?.permission ?? (projectProfile && profile ? {
      sandbox: projectedSandbox, approval: "on-request",
      ...(profile === "off" ? {} : { enforcement: "os" }),
    } : undefined);
    const effective = observed ? { sandbox: observed.permission.sandbox, network_access: observed.network_access }
      : projectProfile && profile ? { sandbox: projectedSandbox, network_access: profile !== "read-only" } : undefined;
    const switching = this.#platform === "linux" && this.#permissions.syncSupported;
    return {
      engine: "grok",
      models: [{ value: "default", display_name: "Account default" }],
      model: "default",
      model_source: "default",
      ...(permission ? { permission } : {}),
      ...(effective ? { effective } : {}),
      ...(this.#current ? { permission_policy: this.#current.policy } : {}),
      ...(this.#permissions.latest ? { permission_control: this.#permissions.latest } : {}),
      ...(this.#permissions.gate ? { permission_gate: this.#permissions.gate } : {}),
      session_capabilities: {
        supports_model_switch: false,
        supports_effort_switch: false,
        supports_permission_switch: switching,
        supports_permission_mode_switch: false,
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_session_reset: false,
        supports_context_usage: false,
        permission_switch_axes: switching ? { sandbox: { max: pair.sandbox }, network_access: { max: pair.network_access } } : {},
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
      sandboxProfile(config, this.#options.cwd, this.#options.env ?? process.env, this.#platform);
      await this.#inLane(() => this.#replace(this.#ceiling));
      this.#starting = false;
      if (!this.#closing) {
        this.#started = true;
        this.#state("waiting_input");
        if (prompt !== undefined) void this.send(prompt).catch(() => {});
        void this.#drain();
      }
      await this.closed;
      if (this.#failure) throw this.#failure;
    } catch (error) {
      this.#starting = false;
      const stopping = this.#closing && !this.#failure;
      if (!stopping) this.#state("error");
      if (error instanceof GrokLaunchError) {
        this.#options.send(makeLog(config, this.state, new Date().toISOString(),
          { kind: "system", text: error.message }));
      }
      this.close();
      await this.closed;
      if (!stopping) throw error;
    }
  }

  #inLane(action: () => Promise<void>): Promise<void> {
    const result = this.#lane.then(action);
    this.#lane = result.catch(() => {});
    return result;
  }
  async #retire(generation: Generation | undefined) {
    if (!generation) return;
    generation.role = "retired";
    if (this.#current === generation) this.#current = undefined;
    if (this.#loading === generation) this.#loading = undefined;
    generation.session.connection.close();
    generation.toolHost.close();
    await generation.process.close();
  }
  #generationFailed(generation: Generation, error: Error) {
    if (generation.role === "retired") return;
    if (generation.role === "loading") {
      generation.failure ??= error;
      generation.fail(error);
      return;
    }
    if (!this.#closing) {
      this.#failure = error;
      this.close();
    }
  }
  async #replace(selection: Selection) {
    let step: LaneStep = "stopping";
    let generation: Generation | undefined;
    let toolHost: ToolHost | undefined;
    let expired = false;
    const abort = new AbortController();
    const signal = AbortSignal.any([this.#lifetime.signal, abort.signal]);
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("grok lane aborted"));
      else signal.addEventListener("abort", () => reject(new Error("grok lane aborted")), { once: true });
    });
    void aborted.catch(() => {});
    const check = () => {
      if (this.#closing || signal.aborted) throw new Error("grok lane aborted");
    };
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      const value = await Promise.race([promise, aborted, ...(generation ? [generation.failed] : [])]);
      check();
      return value;
    };
    const at = async (value: LaneStep) => {
      step = value;
      check();
      if (this.#options.onLaneStep) {
        const observed = Promise.resolve(this.#options.onLaneStep(value, generation?.process.child.pid));
        if (value === "promotion") await Promise.race([observed, aborted]);
        else await wait(observed);
      }
      check();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await at("stopping");
      await this.#retire(this.#current);
      check();
      timer = setTimeout(() => { expired = true; abort.abort(); }, 30_000);
      await at("inspect");
      const profile = sandboxProfile(selection.requested, this.#options.cwd,
        this.#options.env ?? process.env, this.#platform);
      const env = childEnvironment(this.#options.env ?? process.env, profile);
      const executable = this.#options.executable ?? "grok";
      const policy = await wait(inspectPolicy(executable, this.#options.cwd, env, profile, signal));
      // Always collect the listener even if close won while listen was pending.
      toolHost = await ToolHost.listen(this.#options.toolDescriptors ?? [],
        { turnSignal: () => this.#signal?.signal ?? null });
      check();
      await at("spawn");
      const childProcess = new GrokProcess(executable, this.#options.cwd, env);
      let fail!: (error: Error) => void;
      const failed = new Promise<never>((_, reject) => { fail = reject; });
      void failed.catch(() => {});
      const connection = connectAcp<GrokWireMetadata>(childProcess.child, {
        update: (notification) => { if (generation?.role === "current") this.#update(notification); },
        permission: (request, requestSignal) => generation?.role === "current"
          ? this.#permission(request, requestSignal)
          : Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
        metadata: (metadata) => { if (generation?.role === "current") this.#options.onMetadata?.(metadata); },
      }, grokExtension((notification) => { if (generation?.role === "current") this.#vendor(notification); }));
      generation = { role: "loading", process: childProcess, session: new AcpSession(connection), toolHost,
        profile, policy, failed, fail };
      this.#loading = generation;
      const owned = generation;
      void connection.closed.then(() => this.#generationFailed(owned, new Error("grok ACP connection closed unexpectedly")));
      void childProcess.exited.then(() => this.#generationFailed(owned, new Error("grok child exited unexpectedly")),
        (error: Error) => this.#generationFailed(owned, error));
      await at("initialize");
      const initialized = await wait(generation.session.initialize());
      if (initialized.agentCapabilities?.mcpCapabilities?.http !== true)
        throw new GrokLaunchError("grok does not support HTTP MCP servers");
      await at("load");
      if (this.#sessionId) {
        if (initialized.agentCapabilities?.loadSession !== true) throw new Error("grok session load unsupported");
        await wait(generation.session.load(this.#sessionId, this.#options.cwd, [toolHost.mcpServer()]));
      } else {
        await wait(generation.session.newSession(this.#options.cwd, [toolHost.mcpServer()],
          grokSessionMeta(this.#options.personaPrompt)));
      }
      await at("readiness");
      await wait(toolHost.listed(this.#options.mcpReadyTimeoutMs ?? MCP_READY_TIMEOUT_MS)
        .catch(() => { throw new GrokLaunchError(MCP_NOT_CONNECTED); }));
      await at("promotion");
      check();
      if (generation.failure) throw new LaneFailure("loading_exit");
      generation.role = "current";
      this.#current = generation;
      this.#loading = undefined;
      this.#sessionId = generation.session.sessionId;
      this.#completion = undefined;
      this.#options.onSessionId?.(this.#sessionId!);
    } catch (error) {
      if (!this.#sessionId) throw error;
      throw error instanceof LaneFailure ? error : new LaneFailure(expired ? "deadline" :
        (step as LaneStep) === "promotion" ? "loading_exit" : step as Exclude<LaneStep, "promotion">);
    } finally {
      clearTimeout(timer);
      if (generation && generation.role !== "current") await this.#retire(generation);
      else if (!generation) toolHost?.close();
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

  async #awaitDispatch(): Promise<boolean> {
    let deadline: number | undefined;
    while (!this.#closing) {
      if (this.#permissions.gate) {
        deadline ??= Date.now() + (this.#options.permissionGateTimeoutMs ?? 30_000);
        this.#state("waiting_permission");
      }
      if (deadline !== undefined && Date.now() >= deadline) return false;
      let wake!: () => void;
      const awakened = new Promise<false>((resolve) => { wake = () => resolve(false); });
      this.#wake = wake;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadline !== undefined) timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
      try {
        const ready = await Promise.race([
          (this.#options.waitForPermissionSync?.() ?? Promise.resolve()).then(() => true), awakened,
        ]);
        if (this.#closing) return false;
        if (!ready) continue;
        if (!this.#permissions.gate && this.#permissions.next) return true;
        if (deadline === undefined) {
          deadline = Date.now() + (this.#options.permissionGateTimeoutMs ?? 30_000);
          this.#state("waiting_permission");
          timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        }
        await awakened;
      } finally { clearTimeout(timer); this.#wake = undefined; }
    }
    return false;
  }
  async #drain() {
    if (this.#draining || !this.#started || this.#closing) return;
    this.#draining = true;
    try {
      while (this.#queue.length && !this.#closing) {
        const turn = this.#queue[0]!;
        if (!await this.#awaitDispatch()) {
          if (this.#closing) return;
          this.#queue.shift();
          const error = new Error("permission_gate_blocked");
          this.#options.send(makeResult(this.#options.config, new Date().toISOString(),
            { text: "", is_error: true, error_code: "permission_gate_blocked" }));
          this.#options.onTurnEnd?.({ turnToken: turn.token, conversationIds: turn.conversations,
            error: { detail: "permission gate blocked", reason: "permission_gate_blocked" } });
          turn.reject(error);
          this.#state("waiting_input");
          continue;
        }
        const submission = capturePermission(this.#permissions, turn.token);
        if (!submission) continue;
        let profile: SandboxProfile | undefined;
        try {
          profile = sandboxProfile(submission.requested, this.#options.cwd,
            this.#options.env ?? process.env, this.#platform);
        } catch {
          this.#permissions = permissionLaneFailed(this.#permissions, submission,
            undefined, new Date().toISOString(), "unsupported_permission_pair");
          this.#reportFailed(submission, "unsupported_permission_pair");
          this.#state(this.state);
          continue;
        }
        if (profile !== this.#current?.profile) {
          try { await this.#inLane(() => this.#replace(submission)); }
          catch (error) {
            if (this.#closing) return;
            const failedStep = error instanceof LaneFailure ? error.step : "spawn";
            // The wire has no stopping step; omit it instead of reporting a different phase.
            this.#permissions = permissionLaneFailed(this.#permissions, submission,
              failedStep === "stopping" ? undefined : failedStep, new Date().toISOString());
            this.#reportFailed(submission, "restart_failed");
            this.#state(this.state);
            continue;
          }
        }
        if (this.#closing) return;
        this.#queue.shift();
        await this.#execute(turn, submission);
      }
    } finally { this.#draining = false; }
  }
  async #execute(turn: Turn, submission: PermissionSubmission) {
    this.#permissions = beginPermissionExecution(this.#permissions, submission);
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
      const response = await this.#current!.session.prompt(turn.text);
      this.#observe(submission, promptIdOf(response._meta));
      const completed =
        this.#completion?.sessionId === this.#sessionId &&
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
      if (this.#permissions.current?.submission.execution_id === submission.execution_id &&
        this.#permissions.current.status === "applying") this.#observe(submission, undefined);
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
    if (!this.#active || notification.sessionId !== this.#sessionId)
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
    const completion = turnCompletion(notification, this.#sessionId);
    if (completion) this.#completion = completion;
  }
  async #permission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    if (!this.#active || request.sessionId !== this.#sessionId) {
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
    await this.#current?.session.cancel();
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
    this.#wake?.();
    void this.#inLane(async () => {
      await this.#retire(this.#loading);
      await this.#retire(this.#current);
    }).finally(() => this.#resolveClosed());
  }

  async setModel(_value: string) {
    throw new Error("grok model switching is unsupported");
  }
  async setEffort(_value: string) {
    throw new Error("grok effort switching is unsupported");
  }
  async setPermission(value: PermissionSelection) {
    if (this.#platform !== "linux" || !this.#permissions.syncSupported)
      throw new Error("grok permission switching was not negotiated; permissions are fixed");
    if (value.revision <= (this.#permissions.latest?.revision ?? 0)) return;
    let refusal: string | undefined;
    if (!withinCeiling(value, this.#ceiling)) refusal = "exceeds_launch_ceiling";
    else {
      try { sandboxProfile(value.requested, this.#options.cwd, this.#options.env ?? process.env, this.#platform); }
      catch { refusal = "unsupported_permission_pair"; }
    }
    this.#permissions = requestPermission(this.#permissions, value, refusal);
    if (refusal) this.#reportFailed(value, refusal);
    this.#state(this.state);
    this.#wake?.();
  }
  setPermissionSyncSupported(supported: boolean) {
    this.#permissions = setPermissionSyncSupport(this.#permissions, this.#platform === "linux" && supported);
    this.#state(this.state);
    this.#wake?.();
  }
  applyPermissionSync(message: PermissionSyncMessage) {
    this.#permissions = applyPermissionSyncState(this.#permissions, message, this.#ceiling, new Date().toISOString());
    this.#state(this.state);
    this.#wake?.();
  }
  #reportFailed(selection: Selection, reason: string) {
    if (selection.revision > 0) this.#options.onPermissionLifecycle?.({ version: "0",
      kind: "permission_failed", at: new Date().toISOString(),
      details: { revision: selection.revision, requested: selection.requested, reason } });
  }
  #observe(submission: PermissionSubmission, promptId: unknown) {
    if (!this.#permissions.latest) return;
    if (typeof promptId === "string" && promptId.length > 0) {
      const observation = { ...submission, session_id: this.#sessionId!, turn_id: promptId,
        permission: { sandbox: submission.requested.sandbox, approval: "on-request" as const,
          ...(this.#current!.profile === "off" ? {} : { enforcement: "os" as const }) },
        network_access: effectiveNetworkAccess(submission.requested) };
      const applied = permissionObservationApplied(this.#permissions, observation);
      this.#permissions = applied.state;
      if (applied.emitAudit) this.#options.onPermissionLifecycle?.({ version: "0",
        kind: "permission_applied", at: new Date().toISOString(), details: observation });
    } else {
      this.#permissions = permissionObservationFailed(this.#permissions, submission, new Date().toISOString());
      this.#reportFailed(submission, "observation_unavailable");
    }
    this.#state(this.state);
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
