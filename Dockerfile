FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/request-store/package.json packages/request-store/package.json
COPY packages/traffic-bot/package.json packages/traffic-bot/package.json
RUN npm ci --omit=dev
COPY src ./src
COPY packages ./packages
ARG GIT_SHA=dev
ENV APP_VERSION=$GIT_SHA
USER node
EXPOSE 8080 9091
HEALTHCHECK --interval=30s --timeout=3s CMD node packages/healthcheck.js
CMD ["node", "src/server.js"]
