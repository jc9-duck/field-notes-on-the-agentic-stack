# agentgateway's own official image (cr.agentgateway.dev/agentgateway) is
# Chainguard's distroless glibc-dynamic base — no shell, no envsubst, on
# purpose (see agentgateway/agentgateway's own Dockerfile). That means the
# OIDC_* -> config.yaml rendering this repo's modular-identity design
# depends on can't happen inside the agentgateway container itself. This
# tiny sidecar does it instead: render once into a shared volume, exit,
# then agentgateway (which depends_on this with
# condition: service_completed_successfully) starts and reads the result.
FROM alpine:3.20
RUN apk add --no-cache gettext
# The explicit variable list ('$OIDC_ISSUER $OIDC_AUDIENCE $OIDC_JWKS_URI')
# is required, not optional: bare `envsubst` substitutes *any* $VAR-shaped
# text in the file, including inside YAML comments — bit us once already
# when a comment describing this very mechanism got silently mangled
# because it happened to contain `$`-prefixed example text. Restricting to
# these three names leaves every other `$`/`${...}` in the template
# (comments or otherwise) untouched.
ENTRYPOINT ["sh", "-c", "envsubst '$OIDC_ISSUER $OIDC_AUDIENCE $OIDC_JWKS_URI' < /template/config.yaml.template > /config/config.yaml && echo 'rendered config.yaml:' && cat /config/config.yaml"]
