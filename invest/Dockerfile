# 期末提報「即時投資」— 單一容器：Node 伺服器同時提供 API 與前端。
# 伺服器只用 Node 內建模組（Node 22.18+ 直接執行 TypeScript），執行階段不需要 npm 套件。
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
EXPOSE 8787
VOLUME /data
CMD ["node", "server/main.ts"]
