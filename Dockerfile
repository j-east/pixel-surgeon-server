FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1987 mcp

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ src/
COPY tsconfig.json ./
RUN npx tsc && npm prune --omit=dev

USER mcp

EXPOSE 3000

CMD ["node", "dist/index.js"]
