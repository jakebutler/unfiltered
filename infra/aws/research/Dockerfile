ARG NODE_IMAGE=node:22.22.3-bookworm-slim@sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644
FROM --platform=linux/amd64 ${NODE_IMAGE}
WORKDIR /app
RUN mkdir -p /run/secrets && touch /run/secrets/research-runtime.json /run/secrets/research-binding.json && mkdir -p /run/research-gate
COPY --chown=node:node server.cjs launcher.cjs bounded-file.cjs asset-manifest.json deployment-manifest.json ffmpeg-manifest.json startup-gate.mjs ./
COPY --chown=node:node site-assets/ ./site-assets/
COPY --chown=node:node bin/ ./bin/
USER node
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=512
EXPOSE 8080
CMD ["node","launcher.cjs"]
