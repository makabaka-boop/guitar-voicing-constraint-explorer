# 构建阶段：把原生 TypeScript 页面打包成离线静态文件
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json index.html ./
COPY src ./src
RUN npm run build

# 运行阶段：nginx 托管页面（无任何外部依赖，可离线访问）
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
