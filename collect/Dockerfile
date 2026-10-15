# claritia-collect: the events service. Builds claritia.js, then runs the TypeScript sources directly with Node.
FROM node:22-bookworm-slim AS build
WORKDIR /app/collect
COPY collect/package.json collect/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY collect/ ./
COPY src/lib/web/ /app/src/lib/web/
RUN node script/build.mts

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app/collect
COPY collect/package.json collect/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /root/.npm
COPY --from=build /app/collect/dist ./dist
COPY collect/*.ts ./
COPY src/lib/web/ /app/src/lib/web/
RUN echo '{"type":"module"}' > /app/package.json
USER node
EXPOSE 8080
CMD ["node", "server.ts"]
