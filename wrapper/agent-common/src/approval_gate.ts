// Bridge tools use the engine's captured policy when supplied. Otherwise
// they ask through the shared broker; call lifetime takes precedence over
// either approval path so an abandoned call cannot reserve a later effect.

import type { PermissionDecision } from "./permission.js";
import type {
  ToolDescriptor,
  ToolHandlerContext,
  ToolResult,
} from "./tooling.js";

export interface ApprovalGateOptions {
  /** Optional engine policy; missing, false or failed evaluation still asks. */
  autonomous?: () => boolean;
  /** Asks the operator; normally `PermissionBroker#decide`. Receives the
   *  call's lifetime signal so a late answer cannot resolve a dead call. */
  decide: (
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<PermissionDecision>;
  /** Name shown in the operator's dialog. Defaults to the descriptor's
   *  bare name; Claude reports its SDK-side FQN, so passing the same FQN
   *  keeps the dialog identical across engines. */
  toolName?: string;
  /** Runs BEFORE the operator is asked. A rejected input fails the call
   *  without a dialog: the bridge hands inputs to handlers unvalidated, and
   *  an oversized or malformed input would otherwise reach the dialog
   *  truncated or reserve nothing after the operator already said yes. */
  validate?: (
    input: Record<string, unknown>,
  ) => { ok: true } | { ok: false; message: string };
}

/** Applies the engine policy without changing tool discovery metadata. */
export function operatorApprovalGated(
  descriptor: ToolDescriptor,
  options: ApprovalGateOptions,
): ToolDescriptor {
  const toolName = options.toolName ?? descriptor.name;
  return {
    ...descriptor,
    handler: async (input, context) => {
      const signal = context?.signal;
      if (signal?.aborted) return cancelled(descriptor.name);
      if (options.validate !== undefined) {
        const validation = options.validate(input);
        if (!validation.ok) {
          return errorResult(`${descriptor.name} failed: ${validation.message}`);
        }
      }
      let autonomous = false;
      try { autonomous = options.autonomous?.() === true; } catch { /* Ask on unknown policy. */ }
      if (!autonomous) {
        let decision: PermissionDecision;
        try {
          decision = await options.decide(toolName, input, signal);
        } catch (err) {
          return errorResult(
            `${descriptor.name} was not approved: permission decision failed: ${String(err)}`,
          );
        }
        if (!decision.allow) {
          return errorResult(
            `${descriptor.name} was not approved by the operator` +
              (decision.message !== undefined ? `: ${decision.message}` : "") +
              ". Nothing was reserved; your context is unchanged.",
          );
        }
      }
      // The allow may have been decided in the same task that ended the
      // turn. Re-check before acting: an effect that outlives the call must
      // not be created for a call nobody can answer any more.
      if (signal?.aborted) return cancelled(descriptor.name);
      return descriptor.handler(input, context);
    },
  };
}

function cancelled(name: string): ToolResult {
  return errorResult(
    `${name} was cancelled: the turn that made this call is no longer ` +
      "live. Nothing was reserved; your context is unchanged.",
  );
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
