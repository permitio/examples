# Two images from one file: `app` (the Next.js server) and `setup` (Terraform and the seed).
FROM hashicorp/terraform:1.17.1 AS terraform

FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

FROM node:24-slim AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# The database volume mounts here; a new volume takes this folder's owner.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]

FROM deps AS setup
COPY --from=terraform /bin/terraform /usr/local/bin/terraform
# Terraform and its provider read CA certificates from the system, which node:24-slim lacks.
COPY --from=terraform /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chown=node:node . .
RUN chown node:node /app && mkdir /data /state && chown node:node /data /state
USER node
# Downloads the Permit provider at build time into a local mirror, which `terraform init` then
# installs from (checked against .terraform.lock.hcl), so setup does not need the registry.
RUN terraform providers mirror /home/node/terraform-providers \
  && printf 'provider_installation {\n  filesystem_mirror {\n    path = "%s"\n  }\n}\n' \
    /home/node/terraform-providers > /home/node/.terraformrc
ENV TERRAFORM_STATE_PATH=/state/terraform.tfstate
CMD ["./node_modules/.bin/tsx", "scripts/setup.ts"]
