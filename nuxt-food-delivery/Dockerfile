FROM node:24-slim
WORKDIR /app
ENV NUXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
# The app keeps its meals and orders in /data (a Compose volume).
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
