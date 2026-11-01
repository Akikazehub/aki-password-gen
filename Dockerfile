# aki-password-gen — zero-dependency Node server
FROM node:22-alpine

WORKDIR /app

# No npm install: the server and lib are dependency-free.
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
# The workload is a few KB of string shuffling per request; a 48 MB V8 heap
# cap keeps worst-case RSS far below the compose mem_limit.
ENV NODE_OPTIONS=--max-old-space-size=48

EXPOSE 3000

USER node

# busybox wget (~1 MB process) instead of spawning a second full node runtime
# (~35 MB) for every health probe.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/v1/healthz" || exit 1

CMD ["node", "server.js"]
