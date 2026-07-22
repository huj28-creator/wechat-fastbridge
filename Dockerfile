FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY bridge ./bridge

# Registry containers can inspect the MCP protocol and tool schemas. Real WeChat
# operations intentionally remain macOS-only and return MACOS_REQUIRED here.
ENV NODE_ENV=production
CMD ["node", "bridge/server.mjs"]
