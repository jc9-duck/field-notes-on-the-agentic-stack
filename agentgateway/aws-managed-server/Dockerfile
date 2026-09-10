FROM node:22-slim

# mcp-proxy-for-aws (spawned below, stdio) needs Python + uv for `uvx`;
# mcp-proxy itself -- the actual stdio->HTTP bridge, since agentgateway's
# distroless image can't spawn a stdio subprocess itself -- is a plain npm
# package, baked in here so container start doesn't refetch it every time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-pip ca-certificates \
    && pip install --break-system-packages --no-cache-dir uv \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && npm install -g mcp-proxy@6.7.16

EXPOSE 3004
# --server stream: Streamable HTTP, matching the transport math-server/
# docs-server already use (not the legacy SSE leg). mcp-proxy-for-aws
# itself is fetched fresh via `uvx` each start, same as mcp/.mcp.json
# already does directly -- not baked in, so version bumps land without
# rebuilding this image. AWS credentials (AWS_PROFILE/AWS_REGION + the
# mounted ~/.aws) come from this service's docker-compose environment/
# volumes and are inherited by this whole process tree -- no separate
# plumbing needed for the uvx child to see them.
CMD ["mcp-proxy", "--port", "3004", "--host", "0.0.0.0", "--server", "stream", "--", \
     "uvx", "mcp-proxy-for-aws@1.6.4", "https://aws-mcp.us-east-1.api.aws/mcp", \
     "--metadata", "AWS_REGION=us-east-1"]
