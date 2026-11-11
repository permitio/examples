FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod
COPY src/ src/
USER node
EXPOSE 3000
# Node runs the TypeScript sources directly: it strips the types.
CMD ["node", "src/index.ts"]
