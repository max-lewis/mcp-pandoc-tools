FROM node:22-alpine

WORKDIR /app
COPY mcp.mjs /app/mcp.mjs

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "/app/mcp.mjs"]
