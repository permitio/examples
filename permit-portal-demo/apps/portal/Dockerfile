FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/great-eagle-systems/package.json apps/great-eagle-systems/
COPY apps/portal/package.json apps/portal/
COPY vendor/ vendor/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build:web
CMD ["pnpm", "exec", "tsx", "apps/portal/src/server/index.ts"]
