const state = {
  catalog: null,
  query: "",
  currentPath: "",
};

const els = {
  fileCount: document.querySelector("#fileCount"),
  categoryCount: document.querySelector("#categoryCount"),
  totalSize: document.querySelector("#totalSize"),
  backupState: document.querySelector("#backupState"),
  catalogSource: document.querySelector("#catalogSource"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  updatedAt: document.querySelector("#updatedAt"),
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  upButton: document.querySelector("#upButton"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  resultSummary: document.querySelector("#resultSummary"),
  fileRows: document.querySelector("#fileRows"),
  emptyState: document.querySelector("#emptyState"),
  usageStatus: document.querySelector("#usageStatus"),
  usagePeriod: document.querySelector("#usagePeriod"),
  usageNote: document.querySelector("#usageNote"),
  classAUsed: document.querySelector("#classAUsed"),
  classALimit: document.querySelector("#classALimit"),
  classARemaining: document.querySelector("#classARemaining"),
  classAProgress: document.querySelector("#classAProgress"),
  classBUsed: document.querySelector("#classBUsed"),
  classBLimit: document.querySelector("#classBLimit"),
  classBRemaining: document.querySelector("#classBRemaining"),
  classBProgress: document.querySelector("#classBProgress"),
  bucketClassA: document.querySelector("#bucketClassA"),
  bucketClassB: document.querySelector("#bucketClassB"),
  classARemainingTop: document.querySelector("#classARemainingTop"),
  classBRemainingTop: document.querySelector("#classBRemainingTop"),
  quotaTopState: document.querySelector("#quotaTopState"),
};

boot();

async function boot() {
  bindEvents();
  state.currentPath = pathFromHash();
  await Promise.allSettled([loadCatalog(false), loadR2Usage()]);
}

function bindEvents() {
  els.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase("zh-CN");
    renderExplorer();
  });

  els.refreshButton.addEventListener("click", () => {
    Promise.allSettled([loadCatalog(true), loadR2Usage()]);
  });

  els.upButton.addEventListener("click", () => {
    if (!state.currentPath) return;
    const parts = splitPath(state.currentPath);
    navigate(parts.slice(0, -1).join("/"));
  });

  window.addEventListener("hashchange", () => {
    state.currentPath = pathFromHash();
    state.query = "";
    els.searchInput.value = "";
    renderExplorer();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== els.searchInput) {
      event.preventDefault();
      els.searchInput.focus();
    }
  });
}

async function loadCatalog(live) {
  setLoading(true, live ? "正在扫描 R2 最新内容…" : "正在读取镜像索引…");
  try {
    const response = await fetch(`/api/catalog${live ? "?live=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    state.catalog = await response.json();
    renderStats(response.headers.get("x-openshare-catalog-source") || state.catalog.source || "unknown");
    renderExplorer();
    setHealthy(state.catalog);
  } catch (error) {
    setFailure(error);
  } finally {
    setLoading(false);
  }
}

async function loadR2Usage() {
  els.usageStatus.textContent = "正在读取…";

  try {
    const response = await fetch("/api/r2-usage", { cache: "no-store" });
    const usage = await response.json();

    renderR2Usage(usage, response.ok);
  } catch (error) {
    console.error(error);
    renderR2UsageError("无法连接 R2 Analytics");
  }
}

function renderR2Usage(usage, requestOk) {
  const free = usage.freeQuota || { classA: 1_000_000, classB: 10_000_000 };

  els.classALimit.textContent = number(free.classA);
  els.classBLimit.textContent = number(free.classB);
  els.classARemainingTop.textContent = number(free.classA);
  els.classBRemainingTop.textContent = number(free.classB);
  els.quotaTopState.textContent = "按账号每月重置";
  els.usagePeriod.textContent = usage.period?.start ? `${formatMonth(usage.period.start)} · 本月` : "本月";

  if (!usage.configured) {
    els.usageStatus.textContent = "实时统计未连接";
    els.usageStatus.className = "usage-warning";
    els.classAUsed.textContent = "--";
    els.classBUsed.textContent = "--";
    els.classARemaining.textContent = number(free.classA);
    els.classBRemaining.textContent = number(free.classB);
    els.bucketClassA.textContent = "--";
    els.bucketClassB.textContent = "--";
    els.classARemainingTop.textContent = number(free.classA);
    els.classBRemainingTop.textContent = number(free.classB);
    els.quotaTopState.textContent = "实时统计未连接";
    setProgress(els.classAProgress, 0);
    setProgress(els.classBProgress, 0);
    els.usageNote.textContent =
      "免费额度已显示；如需显示真实本月使用量，请给 Worker 配置 CF_ACCOUNT_ID 与只读的 CF_ANALYTICS_TOKEN。";
    return;
  }

  if (!requestOk || !usage.account) {
    els.usageStatus.textContent = "Analytics 读取失败";
    els.usageStatus.className = "usage-error";
    els.classAUsed.textContent = "--";
    els.classBUsed.textContent = "--";
    els.classARemaining.textContent = "--";
    els.classBRemaining.textContent = "--";
    els.bucketClassA.textContent = "--";
    els.bucketClassB.textContent = "--";
    els.classARemainingTop.textContent = "--";
    els.classBRemainingTop.textContent = "--";
    els.quotaTopState.textContent = "统计暂不可用";
    setProgress(els.classAProgress, 0);
    setProgress(els.classBProgress, 0);
    els.usageNote.textContent = usage.error
      ? `Cloudflare Analytics：${usage.error}`
      : "无法读取 Cloudflare Analytics。请检查 Account Analytics: Read 权限和 Account ID。";
    return;
  }

  const account = usage.account;
  const bucket = usage.bucket || {};

  els.usageStatus.textContent = "Cloudflare Analytics 已连接";
  els.usageStatus.className = "usage-ok";
  els.classAUsed.textContent = number(account.classA);
  els.classBUsed.textContent = number(account.classB);
  els.classARemaining.textContent = number(account.classARemaining);
  els.classBRemaining.textContent = number(account.classBRemaining);
  els.classARemainingTop.textContent = number(account.classARemaining);
  els.classBRemainingTop.textContent = number(account.classBRemaining);
  els.quotaTopState.textContent = `本月已用 A ${number(account.classA)} · B ${number(account.classB)}`;
  els.bucketClassA.textContent = number(bucket.classA || 0);
  els.bucketClassB.textContent = number(bucket.classB || 0);
  setProgress(els.classAProgress, account.classAPercent || 0);
  setProgress(els.classBProgress, account.classBPercent || 0);

  const unknown = Number(account.unknown || 0);
  els.usageNote.textContent = unknown > 0
    ? `账号本月另有 ${number(unknown)} 次未分类操作；额度按账号计算，本桶为 ${usage.bucketName || "当前 R2 bucket"}。监控统计不替代最终 Billing 账单。`
    : `额度按账号计算；“本桶”显示 ${usage.bucketName || "当前 R2 bucket"} 的操作量。监控统计不替代最终 Billing 账单。`;
}

function renderR2UsageError(message) {
  els.usageStatus.textContent = "统计不可用";
  els.usageStatus.className = "usage-error";
  els.classARemainingTop.textContent = "--";
  els.classBRemainingTop.textContent = "--";
  els.quotaTopState.textContent = "统计暂不可用";
  els.usageNote.textContent = message;
}

function setProgress(element, percent) {
  const safe = Math.min(100, Math.max(0, Number(percent) || 0));
  element.style.width = `${safe}%`;
  element.parentElement.setAttribute("aria-label", `已使用 ${safe.toFixed(2)}%`);
}

function renderStats(source) {
  const catalog = state.catalog;
  els.fileCount.textContent = number(catalog.stats?.files ?? catalog.files.length);
  els.categoryCount.textContent = `${number(catalog.stats?.categories ?? catalog.categories?.length ?? 0)} 个顶层目录`;
  els.totalSize.textContent = formatBytes(catalog.stats?.bytes ?? 0);
  els.backupState.textContent = catalog.truncated ? "部分可用" : "正常";
  els.catalogSource.textContent = source === "snapshot" ? "R2 快照索引" : "R2 实时扫描";
}

function renderExplorer() {
  if (!state.catalog) return;

  renderBreadcrumbs();
  els.upButton.disabled = !state.currentPath;

  if (state.query) {
    renderSearchResults();
    return;
  }

  const { folders, files } = listDirectory(state.currentPath);
  const rows = [
    ...folders.map(folderRow),
    ...files.map(fileRow),
  ];

  els.resultSummary.textContent = `${number(folders.length)} 个文件夹，${number(files.length)} 个文件`;
  els.fileRows.replaceChildren(...rows);

  const empty = rows.length === 0;
  els.emptyState.hidden = !empty;
  if (empty) {
    els.emptyState.querySelector("strong").textContent = state.currentPath ? "这个文件夹是空的" : "这里暂时没有资料";
    els.emptyState.querySelector("span").textContent = "向 R2 上传文件后，点击“检查 R2 最新内容”。";
  }
}

function renderSearchResults() {
  const files = state.catalog?.files || [];
  const matches = files.filter((file) => {
    const haystack = `${file.name} ${file.folder} ${file.extension} ${file.category}`.toLocaleLowerCase("zh-CN");
    return haystack.includes(state.query);
  });

  els.resultSummary.textContent = `全站搜索：找到 ${number(matches.length)} 个文件`;
  els.fileRows.replaceChildren(...matches.slice(0, 1000).map((file) => fileRow(file, true)));

  els.emptyState.hidden = matches.length !== 0;
  if (matches.length === 0) {
    els.emptyState.querySelector("strong").textContent = "没有找到匹配文件";
    els.emptyState.querySelector("span").textContent = "可以尝试文件名、目录名或扩展名。";
  }

  if (matches.length > 1000) {
    els.resultSummary.textContent += "（仅显示前 1000 项，请继续输入关键词缩小范围）";
  }
}

function listDirectory(path) {
  const files = state.catalog?.files || [];
  const prefix = path ? `${path}/` : "";
  const folderMap = new Map();
  const directFiles = [];

  for (const file of files) {
    if (!file.key.startsWith(prefix)) continue;

    const remainder = file.key.slice(prefix.length);
    if (!remainder) continue;

    const slashIndex = remainder.indexOf("/");
    if (slashIndex === -1) {
      directFiles.push(file);
      continue;
    }

    const name = remainder.slice(0, slashIndex);
    const folderPath = path ? `${path}/${name}` : name;

    if (!folderMap.has(name)) {
      folderMap.set(name, {
        name,
        path: folderPath,
        files: 0,
        bytes: 0,
        latest: null,
      });
    }

    const folder = folderMap.get(name);
    folder.files += 1;
    folder.bytes += file.size || 0;
    folder.latest = newestDate(folder.latest, file.uploaded);
  }

  const folders = [...folderMap.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  directFiles.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));

  return { folders, files: directFiles };
}

function renderBreadcrumbs() {
  const items = [];

  items.push(breadcrumbButton("根目录", ""));
  const parts = splitPath(state.currentPath);

  parts.forEach((part, index) => {
    const separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.textContent = "›";
    items.push(separator);

    const path = parts.slice(0, index + 1).join("/");
    items.push(breadcrumbButton(part, path, index === parts.length - 1));
  });

  els.breadcrumbs.replaceChildren(...items);
}

function breadcrumbButton(label, path, current = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `breadcrumb${current ? " current" : ""}`;
  button.textContent = label;
  button.disabled = current;
  button.addEventListener("click", () => navigate(path));
  return button;
}

function folderRow(folder) {
  const row = document.createElement("tr");
  row.className = "folder-row";
  row.title = "双击打开文件夹";
  row.addEventListener("dblclick", () => navigate(folder.path));

  const nameCell = document.createElement("td");
  const wrap = document.createElement("div");
  wrap.className = "file-cell";

  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.textContent = "📁";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "entry-name folder-name";
  button.textContent = folder.name;
  button.addEventListener("click", () => navigate(folder.path));

  wrap.append(icon, button);
  nameCell.append(wrap);

  const typeCell = document.createElement("td");
  typeCell.className = "muted";
  typeCell.textContent = `文件夹 · ${number(folder.files)} 个文件`;

  const sizeCell = document.createElement("td");
  sizeCell.textContent = formatBytes(folder.bytes);

  const dateCell = document.createElement("td");
  dateCell.className = "muted";
  dateCell.textContent = formatDate(folder.latest);

  const actionCell = document.createElement("td");
  actionCell.className = "action-cell folder-action-cell";

  const actions = document.createElement("div");
  actions.className = "folder-actions";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "open-folder";
  open.textContent = "打开";
  open.addEventListener("click", () => navigate(folder.path));

  const download = document.createElement("a");
  download.className = "download folder-download";
  download.href = `/download-folder/${encodeURIComponent(folder.path)}`;
  download.textContent = "打包下载";
  download.title = `递归下载 ${folder.name} 及全部子文件夹（TAR）`;
  download.addEventListener("dblclick", (event) => event.stopPropagation());

  actions.append(open, download);
  actionCell.append(actions);

  row.append(nameCell, typeCell, sizeCell, dateCell, actionCell);
  return row;
}

function fileRow(file, showLocation = false) {
  const row = document.createElement("tr");
  row.className = "file-row";
  row.title = "双击下载文件";
  row.addEventListener("dblclick", () => {
    window.location.href = file.downloadUrl || `/download/${encodeURIComponent(file.key)}`;
  });

  const fileCell = document.createElement("td");
  const fileWrap = document.createElement("div");
  fileWrap.className = "file-cell";

  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.textContent = file.extension ? file.extension.slice(0, 4).toUpperCase() : "FILE";

  const nameWrap = document.createElement("div");
  nameWrap.className = "entry-name-wrap";
  const name = document.createElement("strong");
  name.textContent = file.name;
  nameWrap.append(name);

  if (showLocation) {
    const location = document.createElement("small");
    location.textContent = file.folder ? `位置：${file.folder}` : "位置：根目录";
    nameWrap.append(location);
  }

  fileWrap.append(icon, nameWrap);
  fileCell.append(fileWrap);

  const typeCell = document.createElement("td");
  typeCell.className = "muted";
  typeCell.textContent = file.extension ? `${file.extension.toUpperCase()} 文件` : "文件";

  const sizeCell = document.createElement("td");
  sizeCell.textContent = formatBytes(file.size);

  const dateCell = document.createElement("td");
  dateCell.className = "muted";
  dateCell.textContent = formatDate(file.uploaded);

  const actionCell = document.createElement("td");
  actionCell.className = "action-cell";
  const link = document.createElement("a");
  link.className = "download";
  link.href = file.downloadUrl || `/download/${encodeURIComponent(file.key)}`;
  link.textContent = "下载";
  actionCell.append(link);

  row.append(fileCell, typeCell, sizeCell, dateCell, actionCell);
  return row;
}

function navigate(path) {
  const normalized = normalizePath(path);
  const nextHash = normalized ? `#/${encodeURIComponent(normalized)}` : "#/";
  if (window.location.hash === nextHash) {
    state.currentPath = normalized;
    state.query = "";
    els.searchInput.value = "";
    renderExplorer();
    return;
  }
  window.location.hash = nextHash;
}

function pathFromHash() {
  if (!window.location.hash || window.location.hash === "#/" || window.location.hash === "#") return "";
  const raw = window.location.hash.replace(/^#\/?/, "");
  try {
    return normalizePath(decodeURIComponent(raw));
  } catch {
    return "";
  }
}

function normalizePath(path) {
  return splitPath(path).join("/");
}

function splitPath(path) {
  return String(path || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function newestDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

function setLoading(loading, text) {
  els.refreshButton.disabled = loading;
  if (loading && text) {
    els.statusText.textContent = text;
    els.statusDot.classList.remove("healthy", "error");
  }
}

function setHealthy(catalog) {
  els.statusDot.classList.add("healthy");
  els.statusDot.classList.remove("error");
  els.statusText.textContent = catalog.truncated ? "镜像可用，但索引达到上限" : "Cloudflare 镜像在线";
  els.updatedAt.textContent = `索引时间：${formatDateTime(catalog.generatedAt)}`;
}

function setFailure(error) {
  console.error(error);
  els.statusDot.classList.add("error");
  els.statusDot.classList.remove("healthy");
  els.statusText.textContent = "镜像索引读取失败";
  els.updatedAt.textContent = "请检查 Worker 与 R2 绑定";
  els.backupState.textContent = "异常";
  els.catalogSource.textContent = "无法读取文件索引";
  els.resultSummary.textContent = "加载失败";
  els.emptyState.hidden = false;
  els.emptyState.querySelector("strong").textContent = "无法连接文件索引";
  els.emptyState.querySelector("span").textContent = String(error?.message || error);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "--";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatMonth(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "本月";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", timeZone: "UTC" }).format(date);
}

function number(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}
