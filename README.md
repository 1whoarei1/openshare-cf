# OpenShare CF

OpenShare 的 **Cloudflare 只读容灾镜像**。目标不是替代主站，而是在本地服务器完全离线时，仍然让用户完成：

- 像资源管理器一样逐层打开任意深度文件夹
- 全站搜索文件
- 下载已同步文件
- 查看 R2 本月 Class A / Class B 操作量与免费额度

核心组件只有 **Cloudflare Workers Static Assets + Worker + R2**，不依赖主服务器，也不需要 D1。

## 架构

```text
用户
  │
  ├─ / /app.js /assets/* ──────> Workers Static Assets
  │
  ├─ /api/catalog ─────────────> Worker ──> R2 文件索引/实时列表
  ├─ /api/r2-usage ────────────> Worker ──> Cloudflare GraphQL Analytics
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

## 2. 创建 R2 bucket

默认 bucket 名：

```text
openshare-cf-files
```

创建：

```bash
npx wrangler r2 bucket create openshare-cf-files
```

如果更换 bucket 名，请同时修改 `wrangler.jsonc` 中的：

- `r2_buckets[0].bucket_name`
- `vars.R2_BUCKET_NAME`

## 3. 本地开发

```bash
npm run dev
```

Wrangler 默认使用本地模拟 R2。正式测试真实 bucket 时，可以部署后再测试。

## 4. 上传少量测试文件

可以直接在 Cloudflare Dashboard > R2 中上传，例如：

```text
课程/大一/高等数学/2025期末试卷.pdf
课程/大一/计算机/数据结构.zip
软件/工具包.zip
公告/使用说明.txt
```

也可以使用 Wrangler：

```bash
npx wrangler r2 object put openshare-cf-files/课程/测试.txt --file ./测试.txt --remote
```

网页会自动按 Object Key 中的 `/` 还原任意层级目录。

网站首次没有 `_meta/catalog.json` 时，`/api/catalog` 会自动扫描 R2。已经生成过快照索引后，如果刚上传新文件，可以在网页点击 **“检查 R2 最新内容”**。

## 5. 显示真实 R2 操作次数

网页始终会显示 Standard R2 的免费额度：

- Class A：1,000,000 次 / 月
- Class B：10,000,000 次 / 月

若要显示 **Cloudflare 账号本月真实使用量**，需要给 Worker 配置两个变量。

### 5.1 获取 Account ID

在 Cloudflare Dashboard 的账号/域名概览页面找到 Account ID。

添加 Worker 变量：

```text
CF_ACCOUNT_ID=<你的 Account ID>
```

Account ID 本身不属于密码，但建议只在 Worker 配置中维护，不要提交到仓库。

### 5.2 创建只读 Analytics API Token

Cloudflare Dashboard 中创建 **Custom API Token**，权限只需要：

```text
Account
└─ Account Analytics
   └─ Read
```

不要给这个 token R2 写权限，也不要提交到 GitHub。

在 Worker 的 **Settings > Variables and Secrets** 中添加 Secret：

```text
CF_ANALYTICS_TOKEN=<你的 token>
```

如果使用 Wrangler：

```bash
npx wrangler secret put CF_ANALYTICS_TOKEN
```

部署后访问：

```text
/api/r2-usage
```

即可看到本月统计。

页面显示：

- **账号 Class A**：用于和 100 万次/月免费额度比较
- **账号 Class B**：用于和 1000 万次/月免费额度比较
- **本桶**：仅显示 `openshare-cf-files` 这个备用桶的操作量
- 免费剩余次数和进度条

免费额度按 **Cloudflare 账号** 计算，而不是按单个 bucket 计算。如果同一账号还有其他 R2 bucket，它们也会消耗同一份免费额度。

这里读取的是 Cloudflare GraphQL Analytics（Cloudflare Dashboard 的 R2 Metrics 也使用该数据源），用于监控；最终费用仍以 Cloudflare Billing 为准。

## 6. 可选：生成稳定快照索引

生产时建议生成 `_meta/catalog.json`，这样普通用户打开网站时不必每次完整扫描 bucket。

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

## 7. 部署

```bash
npm run deploy
```

部署后 Worker 会：

- 静态资源请求优先由 Workers Static Assets 提供
- `/api/*` 与 `/download/*` 才进入 Worker
- `/download/*` 直接把 R2 `ReadableStream` 返回给客户端
- 支持 HTTP Range 请求
- 支持任意层级文件夹浏览
- 搜索时跨整个资料库查找
- 可选显示真实 R2 Analytics 月度操作量

## 8. 文件夹打包下载

文件夹行现在带有 **“打包下载”** 按钮。

例如：

```text
课程/
└── 大一/
    ├── 高等数学/
    │   └── 试卷.pdf
    └── 英语/
        └── 四级资料.pdf
```

点击 `大一` 右侧的 **打包下载**，Worker 会递归读取该目录下的所有 R2 对象，并流式生成：

```text
大一.tar
```

归档内部仍保留完整子目录结构。

这里使用 **TAR（不压缩）** 而不是运行时 ZIP：

- 不需要把整个文件夹先读入 Worker 内存
- 不需要在 Worker 中对 GB 级文件做压缩
- 下载过程中边读 R2 边输出
- 更适合作为 Cloudflare 免费/低成本容灾站的文件夹下载方式

Windows 11、7-Zip、WinRAR 等都可以直接打开 TAR。

一次文件夹下载会产生：

- 少量 `ListObjects`（Class A）
- 文件夹内每个文件至少一次 `GetObject`（Class B）

单次最多允许 20,000 个文件，避免误点超大目录。

## 9. 生产同步建议

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

检查 Worker、R2 索引和 Analytics 配置状态。

### `GET /api/catalog`

优先返回 `_meta/catalog.json` 快照；没有快照时自动扫描 R2。

### `GET /api/catalog?live=1`

强制实时扫描 R2。

### `GET /api/r2-usage`

查询当前自然月的 R2 Class A / Class B 操作量。

未配置 Analytics token 时仍返回免费额度，但真实使用量为空。

### `POST /api/admin/reindex`

需要 `Authorization: Bearer <ADMIN_TOKEN>`，重新扫描 R2 并生成快照索引。

### `GET /download/<encoded-key>`

从 R2 流式下载对象，支持 Range。

## 配置项

`wrangler.jsonc`：

- `FILES`：R2 bucket binding
- `SITE_TITLE`：站点标题
- `AUTO_INDEX_LIMIT`：单次索引最大文件数
- `R2_BUCKET_NAME`：Analytics 中用于单独统计当前备用 bucket 的名称

Worker Variables / Secrets：

- `CF_ACCOUNT_ID`：可选；Cloudflare Account ID
- `CF_ANALYTICS_TOKEN`：可选；仅需 Account Analytics: Read
- `ADMIN_TOKEN`：可选；reindex API 管理密钥

## 当前定位

这是一个只读容灾站，优先保证：

1. 主服务器完全离线时备用站可独立打开。
2. R2 文件可逐层浏览、搜索和下载。
3. 不提供用户上传、注册、评论等写功能。
4. R2 用量监控使用 Cloudflare 官方 Analytics API，不在浏览器中暴露 API Token。
