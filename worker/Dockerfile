# The Claritia runner: Node 22 with Chromium and its system libraries.
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    NODE_OPTIONS=--no-warnings
WORKDIR /app

# Chromium for the same playwright-core version the runner uses.
RUN npx -y playwright-core@1.63.0 install --with-deps chromium && rm -rf /root/.npm

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /root/.npm

COPY src/lib ./src/lib
COPY worker ./worker

# Run as a normal user, not root.
RUN useradd --create-home runner && chown -R runner /app
USER runner

CMD ["node", "worker/index.ts"]
