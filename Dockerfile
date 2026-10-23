# dreamdex-perps-mcp: an MCP server (stdio) that lets AI agents trade
# dreamDEX perpetuals on the Somnia Hideki testnet.
#
# Build:  docker build -t dreamdex-perps-mcp .
# Run:    docker run -i --rm \
#           -e PRIVATE_KEY=0x... \
#           -e TRADING_ENABLED=true \
#           -e OWNER_ADDRESS=0x... \
#           dreamdex-perps-mcp
#
# Configuration is environment variables only (see .env.example). Without
# PRIVATE_KEY the server is read-only. OWNER_ADDRESS turns on trading-key
# mode: the key is a bot key linked to that DreamDEX account and places
# orders for it, holding no funds itself.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
