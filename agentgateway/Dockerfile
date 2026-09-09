FROM node:22-slim

# Pi baked into the image so you're not reinstalling on every container start.
# --ignore-scripts: disable install-time lifecycle scripts pi doesn't need.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Bake in non-package settings (theme, defaults, retry, etc.) first — the
# `pi install` lines below append their `packages` entries onto this same
# file rather than overwriting it.
COPY pi-settings.json /root/.pi/agent/settings.json

# Pi extensions/packages install to /root/.pi/agent, which isn't a volume —
# `pi install` run inside a container is lost on `--rm`. Bake wanted
# extensions in here instead so they survive every run. Add one `pi install`
# line per package.
RUN pi install npm:pi-web-access
RUN pi install npm:pi-powerline-footer
RUN pi install npm:pi-mcp-adapter

RUN apt-get update && apt-get install -y --no-install-recommends \
    git awscli fd-find ripgrep curl jq \
    && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /work
CMD ["bash"]
