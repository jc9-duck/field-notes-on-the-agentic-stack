  export default async function (pi) {
    const baseUrl = "http://host.docker.internal:11434/v1";
    const res = await fetch(`${baseUrl}/models`);
    const payload = await res.json();

    pi.registerProvider("ollama", {
      name: "Ollama (local)",
      baseUrl,
      apiKey: "ollama",
      api: "openai-completions",
      models: payload.data.map((m) => ({
        id: m.id,
        name: m.id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      })),
    });
  }
