FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/great-eagle-systems/package.json apps/great-eagle-systems/
COPY apps/portal/package.json apps/portal/
COPY vendor/ vendor/
RUN npm ci
COPY . .
RUN npm run build -w @permit-demo/portal
CMD ["npx", "tsx", "apps/portal/src/server/index.ts"]
