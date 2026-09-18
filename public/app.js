const state = {
  catalog: null,
  query: "",
  category: "全部",
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
  categories: document.querySelector("#categories"),
  resultSummary: document.querySelector("#resultSummary"),
  fileRows: document.querySelector("#fileRows"),
  emptyState: document.querySelector("#emptyState"),
};

boot();

async function boot() {
  bindEvents();
  await loadCatalog(false);
}

function bindEvents() {
  els.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase("zh-CN");
    renderFiles();
  });

  els.refreshButton.addEventListener("click", () => loadCatalog(true));

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
    const catalog = await response.json();
    state.catalog = catalog;
    state.category = "全部";
    renderStats(response.headers.get("x-openshare-catalog-source") || catalog.source || "unknown");
    renderCategories();
    renderFiles();
    setHealthy(catalog);
  } catch (error) {
    setFailure(error);
  } finally {
    setLoading(false);
  }
}

function renderStats(source) {
  const catalog = state.catalog;
  els.fileCount.textContent = number(catalog.stats?.files ?? catalog.files.length);
  els.categoryCount.textContent = `${number(catalog.stats?.categories ?? catalog.categories?.length ?? 0)} 个分类`;
  els.totalSize.textContent = formatBytes(catalog.stats?.bytes ?? 0);
  els.backupState.textContent = catalog.truncated ? "部分可用" : "正常";
  els.catalogSource.textContent = source === "snapshot" ? "R2 快照索引" : "R2 实时扫描";
}

function renderCategories() {
  const categories = ["全部", ...(state.catalog?.categories || [])];
  els.categories.replaceChildren(
    ...categories.map((category) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `chip${category === state.category ? " active" : ""}`;
      button.textContent = category;
      button.addEventListener("click", () => {
        state.category = category;
        renderCategories();
        renderFiles();
      });
      return button;
    })
  );
}

function renderFiles() {
  const files = state.catalog?.files || [];
  const filtered = files.filter((file) => {
    if (state.category !== "全部" && file.category !== state.category) return false;
    if (!state.query) return true;
    const haystack = `${file.name} ${file.folder} ${file.extension} ${file.category}`.toLocaleLowerCase("zh-CN");
    return haystack.includes(state.query);
  });

  els.resultSummary.textContent = `显示 ${number(filtered.length)} / ${number(files.length)} 个文件`;
  els.emptyState.hidden = filtered.length !== 0;
  els.fileRows.replaceChildren(...filtered.slice(0, 1000).map(fileRow));

  if (filtered.length > 1000) {
    els.resultSummary.textContent += "（为保证页面流畅，仅渲染前 1000 项；继续输入关键词可缩小范围）";
  }
}

function fileRow(file) {
  const row = document.createElement("tr");

  const fileCell = document.createElement("td");
  const fileWrap = document.createElement("div");
  fileWrap.className = "file-cell";
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.textContent = file.extension ? file.extension.slice(0, 4).toUpperCase() : "FILE";
  const name = document.createElement("strong");
  name.textContent = file.name;
  fileWrap.append(icon, name);
  fileCell.append(fileWrap);

  const folderCell = document.createElement("td");
  folderCell.className = "muted";
  folderCell.textContent = file.folder || "根目录";

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

  row.append(fileCell, folderCell, sizeCell, dateCell, actionCell);
  return row;
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

function number(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}
