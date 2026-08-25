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
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
    })),
  });
}
