# The Node.js major version mirrors `.node-version`; keep them in sync.
# Node.js 25+ no longer bundles Corepack, so it is installed explicitly.
FROM node:26-alpine AS builder

WORKDIR /app

RUN npm install -g corepack@0.36.0 && corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:26-alpine AS runtime

WORKDIR /app

RUN npm install -g corepack@0.36.0 && corepack enable

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
# `tsc` emits `dist/src/index.js`, which serves static files from `../public`,
# i.e. `dist/public`.
COPY public ./dist/public

ENV PORT=80
EXPOSE 80

# UID 1000 is the `node` user of the base image.
USER 1000

CMD ["node", "dist/src/index.js"]
