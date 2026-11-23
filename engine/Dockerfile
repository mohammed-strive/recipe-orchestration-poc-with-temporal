# One image for the engine API and every worker role; docker-compose picks the role.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# python3 runs plugin scripts (code steps); git fetches plugins from the marketplace.
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json .
ENV NODE_ENV=production
EXPOSE 7400
CMD ["node", "dist/api/index.js"]
