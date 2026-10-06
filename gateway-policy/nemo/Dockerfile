# NVIDIA NeMo Guardrails server, pinned. NVIDIA publishes no image (their docs say build from
# the repo), so this installs the pinned PyPI release. The `server` extra adds FastAPI/uvicorn;
# the default LLM framework is httpx-based (no LangChain), which is all `engine: openai` needs
# to reach Bedrock's OpenAI-compatible endpoint.
FROM python:3.12-slim
RUN pip install --no-cache-dir "nemoguardrails[server]==0.24.1"
WORKDIR /app
EXPOSE 8000
# /config holds one sub-folder per rails configuration (here: `gateway`).
CMD ["nemoguardrails", "server", "--config", "/config", "--port", "8000"]
