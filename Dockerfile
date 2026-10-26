# Build from the repository root: this app uses npm workspace dependencies.
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
ENV NX_DAEMON=false NX_NO_CLOUD=true
COPY . .
RUN npm ci
RUN npx nx build socket-server --output-style=static

FROM node:24.22.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/socket-server/package.json ./apps/socket-server/package.json
COPY --from=build /app/libs/shared/types/package.json ./libs/shared/types/package.json
COPY --from=build /app/libs/shared/types/prompt.js ./libs/shared/types/prompt.js
RUN npm ci --omit=dev --workspace=@living-community-assistant/socket-server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/apps/socket-server/dist ./apps/socket-server/dist
USER node
EXPOSE 8080
CMD ["node", "--unhandled-rejections=strict", "apps/socket-server/dist/main.cjs"]
