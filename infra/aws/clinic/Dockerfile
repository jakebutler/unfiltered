ARG NODE_IMAGE=node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
FROM ${NODE_IMAGE}
ARG SOURCE_DATE_EPOCH=0
WORKDIR /app
RUN mkdir -p /run/secrets && touch -d @0 /run/secrets/clinic-config.json /run/secrets /run
COPY --chown=node:node server.cjs launcher.cjs asset-manifest.json deployment-manifest.json ./
COPY --chown=node:node public/ ./public/
USER node
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=512
EXPOSE 8080
CMD ["node", "launcher.cjs"]
