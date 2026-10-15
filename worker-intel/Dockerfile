# claritia-intel: the jobs that need no browser. Runs the TypeScript sources directly with Node.
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# The image root is the package, so shared files under src/ and collect/ find the same node_modules.
COPY worker-intel/package.json worker-intel/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /root/.npm
COPY worker-intel/ ./worker-intel/
COPY src/lib/jobs.ts src/lib/seal.ts ./src/lib/
COPY src/lib/identity/ ./src/lib/identity/
COPY collect/ids.ts ./collect/
USER node
EXPOSE 8080
CMD ["node", "worker-intel/index.ts"]
