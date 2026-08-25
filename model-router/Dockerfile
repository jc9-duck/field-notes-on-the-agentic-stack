# Build switchyard-server in the official Rust image rather than curl-piping
# rustup.rs inside the main image: that install script fails under this
# network's TLS interception (same class of issue as the AWS CLI installer
# below), and a multi-stage build also keeps the whole Rust toolchain out of
# the final image — only the compiled binary gets copied over.
#
# Built statically against musl rather than glibc: a glibc-linked binary from
# this builder needs its base image on the exact same Debian release as the
# final image's base (node:22-slim) or it fails at runtime with a GLIBC
# version mismatch. Static musl linking sidesteps that entirely — the binary
# has no libc dependency at all, so it runs in any base image. (Switchyard
# uses rustls, not OpenSSL, so musl has no C-TLS-library complications here.)
#
# The musl target is picked from the builder's own arch (native build, not
# cross-compiled) rather than hardcoded: `musl-tools` only provides a native
# musl-gcc, so a hardcoded aarch64 target builds fine on Apple Silicon but
# fails on x86_64 CI runners with "aarch64-linux-musl-gcc: No such file".
FROM rust:latest AS switchyard-builder
RUN case "$(uname -m)" in \
      x86_64) MUSL_TARGET=x86_64-unknown-linux-musl ;; \
      aarch64) MUSL_TARGET=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
    esac \
    && rustup target add "$MUSL_TARGET" \
    && apt-get update && apt-get install -y --no-install-recommends musl-tools \
    && cargo install --locked switchyard-server --target "$MUSL_TARGET"

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
# ca-certificates: node:22-slim doesn't ship it, and awscli's bundled
# botocore CA bundle silently papered over the gap until switchyard-server
# arrived — its reqwest/rustls-platform-verifier client fails to build at
# all without a system root store (confirmed: "upstream transport error:
# builder error" on every route, even a plain-http one, until this was
# installed), since it needs one shared client regardless of per-target
# scheme.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git awscli fd-find ripgrep curl ca-certificates \
    && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# NeMo switchyard-server, built in the switchyard-builder stage above.
COPY --from=switchyard-builder /usr/local/cargo/bin/switchyard-server /usr/local/bin/switchyard-server

# entrypoint.sh starts switchyard-server in the background (against the
# bind-mounted routes.toml, so routing changes don't need a rebuild) before
# handing off to the container's actual command.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["entrypoint.sh"]
CMD ["bash"]
