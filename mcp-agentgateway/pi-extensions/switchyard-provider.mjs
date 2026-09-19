// Route ids (routes.toml's [routes.X] id, as served by Switchyard's own
// /v1/models) whose target actually accepts image content parts. Everything
// else defaults to text-only — most routes here are text models, and a model
// wrongly advertised as image-capable would let pi attach an image that then
// fails upstream instead of being caught at pi's own attach-time check.
const IMAGE_CAPABLE_ROUTE_IDS = new Set(["vision"]);

export default async function (pi) {
  const baseUrl = "http://127.0.0.1:4000/v1";
  const res = await fetch(`${baseUrl}/models`);
  const payload = await res.json();

  pi.registerProvider("switchyard", {
    name: "SwitchYard (router)",
    baseUrl,
    apiKey: "switchyard",
    api: "openai-completions",
    models: payload.data.map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: IMAGE_CAPABLE_ROUTE_IDS.has(m.id) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
    })),
  });
}
