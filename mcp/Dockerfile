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
RUN pi install npm:pi-subagents
# AWS CLI in the image too — useful for `aws sts get-caller-identity` sanity
# checks and, later, for pulling secrets from Secrets Manager/SSM.
#
# Using the Debian package (not the official curl'd installer script):
# the installer script downloads straight from awscli.amazonaws.com, which
# fails under corporate TLS-inspecting proxies (Zscaler etc.) with a cert
# verification error since the container doesn't trust the injected root CA.
# apt already goes through a working path, so route through it instead.
# python3-pip + uv: needed to run `uvx mcp-proxy-for-aws` for the AWS MCP
# Server configured in .mcp.json (see that file for why: the old self-hosted
# awslabs.aws-api-mcp-server is superseded by AWS's managed one, reached only
# through this proxy).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git awscli fd-find ripgrep python3-pip wget \
    && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
    && pip install --break-system-packages --no-cache-dir uv \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# GitHub CLI: authenticates via GH_TOKEN env var at runtime (never baked into
# the image), so `gh auth setup-git` in the entrypoint config below makes
# `git push`/`gh repo create`/etc. work over HTTPS without touching SSH keys.
# Avoids two problems: the host's global SSH config hardcodes an unrelated
# identity for all github.com hosts (same issue already worked around for
# this repo's own remote), and gh's token normally lives in the macOS
# Keychain, which a Linux container can't read at all.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["entrypoint.sh"]
CMD ["bash"]
