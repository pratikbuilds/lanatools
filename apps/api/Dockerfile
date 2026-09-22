FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile
COPY apps/api apps/api
COPY packages/contracts packages/contracts
RUN bun run --cwd apps/api build

FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /app/apps/api/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "dist/index.js"]
