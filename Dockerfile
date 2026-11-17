# syntax=docker/dockerfile:1
# agent-games-router — zero-dependency Node proxy.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json server.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "server.js"]
