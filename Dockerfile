FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/install-opa.mjs && npm run build && chown -R node:node /app
USER node
CMD ["npm", "start"]
