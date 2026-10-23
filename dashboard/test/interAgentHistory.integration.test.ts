import "./isolation.setup.ts";
// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { conversationEntryKey } from "../src/lib/conversationTimeline";
import type { DirectoryEntry, Envelope, PersonaManifest } from "../src/lib/protocol";
import { makeReactiveTimelineDetailProps } from "./reactiveProps.svelte";

let component: object | null = null;
let originalClientHeight: PropertyDescriptor | undefined;
let originalScrollHeight: PropertyDescriptor | undefined;
let originalScrollTo: PropertyDescriptor | undefined;
let originalOffsetTop: PropertyDescriptor | undefined;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  } else {
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
  if (originalScrollHeight) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
  } else {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  } else {
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  }
  if (originalOffsetTop) {
    Object.defineProperty(HTMLElement.prototype, "offsetTop", originalOffsetTop);
  } else {
    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
  }
  originalClientHeight = undefined;
  originalScrollHeight = undefined;
  originalScrollTo = undefined;
  originalOffsetTop = undefined;
});

function state(agentId: string, name: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name, sprite_set: agentId },
    ts: "2026-07-13T05:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {},
  };
}

const message: Envelope = {
  ...state("agent-a", "A"),
  type: "inter_agent_message",
  payload: {
    to: "agent-b",
    conversation_id: "cnv-105-render",
    turn_number: 3,
    kind: "inform",
    body: "復元されたメッセージ",
    meta: { done: false, propose_next: "reply" },
    owner: { kind: "agent", id: "agent-a" },
  },
};

async function render(
  selected: Envelope,
  options: {
    agents?: Record<string, Envelope>;
    directory?: Record<string, DirectoryEntry>;
    logs?: Envelope[];
    manifest?: PersonaManifest | null;
    onSelectAgent?: (agentId: string) => void;
  } = {},
) {
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(AgentDetail, {
    target,
    props: {
      envelope: selected,
      logs: options.logs ?? [message],
      agents: options.agents ?? {
        "agent-a": state("agent-a", "A"),
        "agent-b": state("agent-b", "B"),
      },
      directory: options.directory ?? {},
      manifest: options.manifest ?? null,
      onClose: vi.fn(),
      ...(options.onSelectAgent ? { onSelectAgent: options.onSelectAgent } : {}),
    },
  });
  await tick();
  return target;
}

describe("inter-agent restored history rendering (#102)", () => {
  it("sender detail に outgoing bubble を描画する", async () => {
    const target = await render(state("agent-a", "A"));
    const bubble = target.querySelector(".inter-agent.outgoing");
    expect(bubble?.textContent?.replace(/\s+/g, " ").trim()).toContain("to B(agent-b)");
    expect(bubble?.textContent).toContain("復元されたメッセージ");
  });

  it("receiver detail に incoming bubble を描画する", async () => {
    const target = await render(state("agent-b", "B"));
    const bubble = target.querySelector(".inter-agent.incoming");
    expect(bubble?.textContent?.replace(/\s+/g, " ").trim()).toContain("from A(agent-a)");
    expect(bubble?.textContent).toContain("復元されたメッセージ");
  });

  it("clickable header uses the directory name and the peer state for its CSS face", async () => {
    const peer = {
      ...state("agent-b", "B"),
      display_name: "live-old",
      state: "waiting_input",
    };
    const onSelectAgent = vi.fn();
    const target = await render(state("agent-a", "A"), {
      agents: { "agent-a": state("agent-a", "A"), "agent-b": peer },
      directory: {
        "agent-b": {
          persona: { id: "directory", name: "Directory persona", sprite_set: "directory" },
          display_name: "Directory name",
          last_seen: null,
        },
      },
      onSelectAgent,
    });

    const link = target.querySelector<HTMLButtonElement>(".inter-agent-head .peer-link");
    const portrait = link?.querySelector<HTMLElement>(".peer-portrait");
    expect(link?.textContent).toContain("Directory name(agent-b)");
    expect(portrait?.getAttribute("data-state")).toBe("waiting_input");
    expect(portrait?.querySelector(".face")).not.toBeNull();

    link?.click();
    expect(onSelectAgent).toHaveBeenCalledWith("agent-b");
  });

  it("text-only directory peer keeps its name and renders a small disconnected sprite", async () => {
    const selected = state("agent-a", "A");
    const target = await render(selected, {
      agents: { "agent-a": selected },
      directory: {
        "agent-b": {
          persona: { id: "bee", name: "Bee", sprite_set: "bee" },
          display_name: "Directory Bee",
          last_seen: null,
        },
      },
      manifest: {
        version: "1",
        personas: {
          bee: {
            states: {
              disconnected: { url: "/bee-offline.png", hash: "sha256:offline" },
            },
          },
        },
      },
    });

    const label = target.querySelector<HTMLElement>(".inter-agent-head .peer-static");
    const portrait = label?.querySelector<HTMLElement>(".peer-portrait");
    const sprite = portrait?.querySelector<HTMLImageElement>("img.portrait-sprite");
    expect(label?.textContent).toContain("Directory Bee(agent-b)");
    expect(portrait?.getAttribute("data-state")).toBe("disconnected");
    expect(sprite?.getAttribute("data-size")).toBe("timeline");
    expect(sprite?.getAttribute("src")).toBe("/bee-offline.png");
  });

  it("server peer stays text-only even when the detail can select peers", async () => {
    const serverMessage: Envelope = {
      ...message,
      payload: { ...message.payload, to: "server" },
    };
    const target = await render(state("agent-a", "A"), {
      onSelectAgent: vi.fn(),
      logs: [serverMessage],
    });

    expect(target.querySelector(".inter-agent-head .peer-link")).toBeNull();
    expect(target.querySelector(".inter-agent-head .peer-static")).toBeNull();
    expect(target.querySelector(".inter-agent-head code")?.textContent).toBe("server");
    expect(target.querySelector(".inter-agent-head .peer-portrait")).toBeNull();
  });

  it("timeline target の message body anchor へ 24px 余白つきで smooth scroll する", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("log") ? 400 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("log") ? 600 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("msg") ? 520 : 0;
      },
    });
    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveTimelineDetailProps({
      envelope: state("agent-a", "A"),
      logs: [message],
      agents: { "agent-a": state("agent-a", "A"), "agent-b": state("agent-b", "B") },
      scrollToEntryKey: conversationEntryKey(message),
      onClose: vi.fn(),
    });
    component = mount(AgentDetail, {
      target,
      props,
    });

    const log = target.querySelector<HTMLDivElement>(".log")!;
    const entry = target.querySelector<HTMLElement>("[data-envelope-key]")!;
    const messageBody = entry.querySelector<HTMLElement>(".msg");
    await tick();
    await Promise.resolve();
    await tick();

    expect(entry.dataset.envelopeKey).toBe(conversationEntryKey(message));
    expect(messageBody).not.toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({ top: 496, behavior: "smooth" });
    expect(log.style.getPropertyValue("--timeline-scroll-tail")).toBe("296px");

    // A history clear/reset can remove the selected row without changing the
    // selected detail pane. Its temporary scroll tail must disappear too.
    props.logs = [];
    await tick();
    await Promise.resolve();
    expect(log.style.getPropertyValue("--timeline-scroll-tail")).toBe("0px");
  });
});
