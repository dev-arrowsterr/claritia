# The tunnel relay: one small always-on process.
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY relay/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && rm -rf /root/.npm
COPY relay/relay.mjs relay/server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
