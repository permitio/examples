FROM node:24-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
# The app's database and session secret live in /data (a Compose volume shared with `setup`).
# Next.js writes its runtime cache under .next.
RUN mkdir /data && chown -R node:node /data .next
USER node
ENV NODE_ENV=production DATABASE_PATH=/data/auth.db PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
