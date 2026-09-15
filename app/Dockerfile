# Frontline Ops command center.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Production dependencies only -- there are four of them.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# dumb-init reaps zombies and forwards SIGTERM, so Fly's stop signal reaches
# Node and the server closes its connections instead of being killed.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts

# The image ships no secrets; everything comes from `fly secrets`.
USER node

EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
