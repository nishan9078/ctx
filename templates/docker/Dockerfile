# Optional networked dependency preparation image; keep TLS verification enabled.
# docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -f templates/docker/Dockerfile .
FROM node:22-bookworm-slim
# The default runtime uses cached images and an internal network. For networked
# installs the manager mounts the configured public proxy CA read-only, rather
# than copying session trust or credentials into image layers.
WORKDIR /workspace
USER node
