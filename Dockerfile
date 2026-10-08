FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# 빌드한 커밋을 이미지에 구워 넣는다. 배포 매니페스트가 아니라 이미지가 자기 버전을 안다.
# (overlay 는 나중에 렌더러가 다시 만들기 때문에 거기 env 로 두면 지워진다)
ARG GIT_SHA=dev
ENV APP_VERSION=$GIT_SHA

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
