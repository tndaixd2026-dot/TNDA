# 期末提報「即時投資」— 本機版（備援）容器：Node 伺服器 + PGlite（和 Supabase 相同的 schema.sql）。
# 正式活動建議用 Supabase + GitHub Pages；這個容器適合放在任何能跑 Docker 的主機當備援。
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:local

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY supabase ./supabase
COPY --from=build /app/dist ./dist
EXPOSE 8787
VOLUME /data
CMD ["node", "server/main.ts"]
