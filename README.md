# 指板和弦形状搜索

同一和弦在指板上有许多**音高正确却超出手指跨度**的摆法。本工具在枚举时同时施加可弹奏性约束，只保留真正按得出的形状，并按从易到难的顺序排列。

## 规则

- 输入：4–6 根弦的开放弦 MIDI 音高（低→高）、2–5 个不同目标音级、最大品位 3–9
- 每根弦可闷音或按 0–最大品位；弹响弦不少于 3 根
- 弹响弦出现的音级只能来自目标集合，且必须覆盖全部目标音级
- 每根按下的弦算一根手指（不计横按），最多 4 根
- 非零品位的最大最小差不超过 4；没有按弦时跨度算零
- 排序：跨度 → 品位总和 → 从低音弦到高音弦的向量字典序（闷音排在品位之后），仅显示前 20 个

页面可预览任一结果的指板图，并能诊断任意按法被排除的具体原因（合法则给出名次）。

## 目录结构

```
src/search.ts    核心搜索逻辑（纯函数，页面与测试共用）
src/main.ts      原生 TypeScript 页面（无框架、无外部资源，可离线运行）
index.html       页面骨架与样式
tests/           Vitest：三弦小样本全枚举对拍、移调不变性、规则单测、页面冒烟
Dockerfile       多阶段构建：esbuild 打包 → nginx 托管
docker-compose.yml  fret 服务
```

## 本地开发

```bash
npm install
npm test          # Vitest 检验搜索逻辑与页面冒烟
npm run typecheck # tsc --noEmit
npm run build     # esbuild 打包到 dist/（index.html + app.js）
npm run dev       # watch 模式重新打包
```

## Docker Compose 运行

```bash
docker compose up --build
# 打开 http://localhost:8080
```

`fret` 服务先在构建阶段用 esbuild 把页面打包成纯静态文件，再由 nginx 托管，运行时不依赖任何外部网络资源。
