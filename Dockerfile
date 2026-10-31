FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/install-opa.mjs && node scripts/install-terraform.mjs && npm run build && node scripts/prepare-aws.mjs && rm -rf terraform/aws-network/.terraform && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/.tools ./.tools
COPY --from=build /app/web ./web
COPY --from=build /app/policies ./policies
COPY --from=build /app/terraform ./terraform
COPY package.json ./
RUN mkdir -p /app/.data && chown node:node /app/.data && chmod 700 /app/.data
USER node
ENV INFRAFORGE_BIND=0.0.0.0
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
