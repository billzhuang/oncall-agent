import {
  calculateCost,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type FauxResponseFactory,
  type Message,
  type Model,
  type Provider,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/** faux reports cost 0; re-price each final message from the model's cost table, as the real provider does. */
function priced(provider: Provider): Provider {
  const wrap = (model: Model<any>, inner: AssistantMessageEventStream): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    (async () => {
      for await (const e of inner) {
        if (e.type === "done") e.message.usage.cost = calculateCost(model, e.message.usage);
        if (e.type === "error") e.error.usage.cost = calculateCost(model, e.error.usage);
        out.push(e);
      }
      out.end();
    })();
    return out;
  };
  return {
    ...provider,
    getModels: () => provider.getModels(),
    stream: (m, c, o) => wrap(m, provider.stream(m, c, o as any)),
    streamSimple: (m, c, o) => wrap(m, provider.streamSimple(m, c, o)),
  } as Provider;
}

/** What one model request saw: which model, which tools were offered, and the transcript. */
export interface ModelRequest {
  modelId: string;
  tools: string[];
  messages: Message[];
}

/**
 * Answers one model request from the transcript alone (stateless), so it answers the same after eviction and
 * when several Investigations share the model.
 */
export type Script = (transcript: Transcript) => AssistantMessage;

/** Read helpers over a request's transcript. */
export class Transcript {
  constructor(readonly messages: Message[]) {}
  /** The newest non-system message. */
  get last(): Message | undefined {
    return this.messages.filter((m) => m.role !== "system").at(-1);
  }
  /** Text of the first user message: the alert the Investigation was started with. */
  get alert(): string {
    const first = this.messages.find((m) => m.role === "user");
    return first ? textOf(first.content) : "";
  }
  /** The newest tool result, if the newest message is one. */
  get toolResult(): ToolResultMessage | undefined {
    const last = this.last;
    return last?.role === "toolResult" ? last : undefined;
  }
  get toolResultText(): string {
    return this.toolResult ? textOf(this.toolResult.content) : "";
  }
  /** True when the newest message is a user message (the alert, or a nudge). */
  get userSpoke(): boolean {
    return this.last?.role === "user";
  }
  get lastUserText(): string {
    const last = this.last;
    return last?.role === "user" ? textOf(last.content) : "";
  }
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("");
  return "";
}

/** Tools offered to the model: the union of system messages' toolsAdded minus toolsRemoved. */
function offeredTools(messages: Message[]): string[] {
  const tools = new Set<string>();
  for (const m of messages) {
    if (m.role !== "system") continue;
    for (const t of m.toolsAdded ?? []) tools.add(t.name);
    for (const t of m.toolsRemoved ?? []) tools.delete((t as { name: string }).name);
  }
  return [...tools].sort();
}

type ToolCallArgs = Parameters<typeof fauxToolCall>[1];

export const toolCall = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as ToolCallArgs)], { stopReason: "toolUse" });
export const text = (s: string) => fauxAssistantMessage([fauxText(s)]);

export interface ReportArgs {
  whatFired: string;
  evidence: string[];
  suspectedCause: string;
  fixProposed?: boolean;
}

/**
 * The usual investigation: on the alert, call one Datadog tool; on its result, submit the report built from
 * it; otherwise (never reached when submit_report terminates the run) answer with text.
 */
export function investigate(opts: {
  tool?: string;
  args?: Record<string, unknown>;
  report?: (t: Transcript) => ReportArgs;
} = {}): Script {
  const tool = opts.tool ?? "datadog_search_datadog_logs";
  const report =
    opts.report ??
    ((t: Transcript) => ({
      whatFired: "Error rate on checkout above 5%",
      evidence: [`Datadog logs: ${t.toolResultText}`],
      suspectedCause: "A null customer record reaches CheckoutController after the latest deploy",
    }));
  return (t) => {
    if (t.userSpoke) return toolCall(tool, opts.args ?? { query: "service:checkout status:error" });
    if (t.toolResult && t.toolResult.toolName !== "submit_report") return toolCall("submit_report", { ...report(t) });
    return text("done");
  };
}

/** Default per-token price: a 2-3 request Investigation costs cents, well under any cap. */
export const DEFAULT_COST_PER_MTOK = 10;

/** A scripted model under provider id "cloudflare" (same as createAI). Swap the script with `script()`. */
export function scriptedModel(modelId: string, costPerMTok = DEFAULT_COST_PER_MTOK) {
  const faux = fauxProvider({
    provider: "cloudflare",
    models: [{ id: modelId, cost: { input: costPerMTok, output: costPerMTok, cacheRead: 0, cacheWrite: 0 } }],
  });
  const requests: ModelRequest[] = [];
  let current: Script = investigate();
  const step: FauxResponseFactory = (context: TranscriptContext, _options, _state, model) => {
    requests.push({ modelId: model.id, tools: offeredTools(context.messages), messages: context.messages });
    return current(new Transcript(context.messages));
  };
  // One queue serves every Durable Object in the test; an exhausted queue would look like a model failure.
  faux.setResponses(Array.from({ length: 500 }, () => step));
  return {
    faux,
    provider: priced(faux.provider),
    requests,
    script(script: Script) {
      current = script;
    },
  };
}
export type ScriptedModel = ReturnType<typeof scriptedModel>;
