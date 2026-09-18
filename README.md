# OpenShare CF

OpenShare 的 **Cloudflare 只读容灾镜像**。目标不是替代主站，而是在本地服务器完全离线时，仍然让用户完成：

- 浏览资料
- 分类筛选
- 搜索文件
- 下载已同步文件

核心组件只有 **Cloudflare Workers Static Assets + Worker + R2**，不依赖主服务器，也不需要 D1。

## 架构

```text
用户
  │
  ├─ / /app.js /assets/* ──────> Workers Static Assets
  │
  ├─ /api/catalog ─────────────> Worker ──> R2 文件索引/实时列表
  │
  └─ /download/<key> ──────────> Worker ──> R2 文件流
```

R2 中的 `_meta/` 前缀保留给系统使用，不会展示为用户资料。

## 1. 准备环境

需要 Node.js 20+。

```bash
npm install
npx wrangler login
```

Cloudflare 当前推荐新项目使用 `wrangler.jsonc`。本项目已按该格式配置。

## 2. 创建 R2 bucket

默认 bucket 名是：

```text
openshare-cf-files
```

可以直接创建：

```bash
npx wrangler r2 bucket create openshare-cf-files
```

如果你想用其他名字，修改 `wrangler.jsonc` 的 `r2_buckets[0].bucket_name`。

## 3. 本地开发

```bash
npm run dev
```

注意：Wrangler 默认使用本地模拟 R2。正式测试真实 bucket 时，可以部署后再测试，或按 Cloudflare 文档启用 remote binding。

## 4. 上传少量测试文件

你可以直接在 Cloudflare Dashboard > R2 中上传，例如：

```text
课程/高等数学/2025期末试卷.pdf
软件/工具包.zip
公告/使用说明.txt
```

也可以使用 Wrangler：

```bash
npx wrangler r2 object put openshare-cf-files/课程/测试.txt --file ./测试.txt --remote
```

网站首次没有 `_meta/catalog.json` 时，`/api/catalog` 会自动扫描 R2，因此少量测试文件上传后即可显示。

已经生成过快照索引后，如果刚上传了新文件，可以在网页点击 **“检查 R2 最新内容”**，它会绕过旧快照直接读取 R2 最新列表。

## 5. 可选：生成稳定快照索引

生产时建议生成 `_meta/catalog.json`。这样普通用户打开网站时，不需要每次扫描整个 bucket。

先设置管理员密钥：

```bash
npx wrangler secret put ADMIN_TOKEN
```

部署后执行：

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://你的域名/api/admin/reindex
```

Windows PowerShell：

```powershell
$headers = @{ Authorization = "Bearer YOUR_ADMIN_TOKEN" }
Invoke-RestMethod -Method Post -Headers $headers -Uri "https://你的域名/api/admin/reindex"
```

此接口只负责重新扫描 R2 并写入 `_meta/catalog.json`，**不提供用户上传功能**。

如果没有配置 `ADMIN_TOKEN`，该接口默认关闭。

## 6. 部署

```bash
npm run deploy
```

部署后 Worker 会：

- 静态资源请求优先由 Workers Static Assets 提供
- `/api/*` 与 `/download/*` 才进入 Worker
- `/download/*` 直接把 R2 `ReadableStream` 返回给客户端，不把整个文件读进 Worker 内存
- 支持 HTTP Range 请求，方便大文件续传/媒体播放器

## 7. 生产同步建议

主站仍然是内容源。Cloudflare 版只保存最近一次同步内容：

```text
主站内容更新
   ↓
管理员将新增/修改文件同步到 R2
   ↓
POST /api/admin/reindex
   ↓
备用站索引更新
```

服务器完全崩溃时，备用站仍然独立工作；只是内容停留在最后一次成功同步的版本。

## API

### `GET /api/status`

检查 Worker 与 R2 索引状态。

### `GET /api/catalog`

优先返回 `_meta/catalog.json` 快照；没有快照时自动扫描 R2。

### `GET /api/catalog?live=1`

强制实时扫描 R2，不读取快照。适合管理员刚上传文件后的检查。

### `POST /api/admin/reindex`

需要 `Authorization: Bearer <ADMIN_TOKEN>`，重新扫描 R2 并生成快照索引。

### `GET /download/<encoded-key>`

从 R2 流式下载对象，支持 Range。

## 配置项

`wrangler.jsonc`：

- `FILES`：R2 bucket binding
- `SITE_TITLE`：站点标题
- `AUTO_INDEX_LIMIT`：单次索引最大文件数，默认 20000，Worker 内部限制最高 50000

Secret：

- `ADMIN_TOKEN`：可选；未配置时 reindex API 禁用

## 当前定位

这是 **v0.1 容灾骨架**，优先保证：

1. 主服务器完全离线时备用站可独立打开。
2. R2 文件可自动被读取、搜索和下载。
3. 不提供用户上传、注册、评论等写功能。
4. 后续再根据真实资料目录和主站样式做同步脚本、分类规则、统计快照与 UI 细化。
