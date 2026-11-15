# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY . .
RUN mkdir -p /app/data /app/.angular && chown -R node:node /app
USER node
EXPOSE 4200
CMD ["npm", "run", "dev"]

FROM development AS verified
RUN npm run check && npm test && npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS production
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=verified /app/dist/scani/browser ./dist/scani/browser
COPY --chown=node:node server ./server
COPY package.json package-lock.json LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
CMD ["node", "server/index.mjs"]
