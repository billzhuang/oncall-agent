import {
  calculateCost,
  createAssistantMessageEventStream,
  fauxProvider,
  type AssistantMessageEventStream,
  type FauxResponseStep,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";

// Skeleton (#11): no Investigation calls the model yet. #2 scripts it; see notes on stateless response factories.

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

/** A scripted model under provider id "cloudflare" (same as createAI), replaying `steps` in order. */
export function scriptedModel(modelId: string, steps: FauxResponseStep[] = [], costPerMTok = 0) {
  const faux = fauxProvider({
    provider: "cloudflare",
    models: [{ id: modelId, cost: { input: costPerMTok, output: costPerMTok, cacheRead: 0, cacheWrite: 0 } }],
  });
  faux.setResponses(steps);
  return { faux, provider: priced(faux.provider) };
}
export type ScriptedModel = ReturnType<typeof scriptedModel>;
