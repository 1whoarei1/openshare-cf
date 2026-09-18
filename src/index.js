const CATALOG_KEY = "_meta/catalog.json";
const INTERNAL_PREFIX = "_meta/";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status" && request.method === "GET") {
      return handleStatus(env);
    }

    if (url.pathname === "/api/catalog" && request.method === "GET") {
      return handleCatalog(request, env);
    }

    if (url.pathname === "/api/admin/reindex" && request.method === "POST") {
      return handleReindex(request, env);
    }

    if (url.pathname.startsWith("/download/") && request.method === "GET") {
      return handleDownload(request, env, url.pathname);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleStatus(env) {
  const catalogObject = await env.FILES.head(CATALOG_KEY);
  return json({
    ok: true,
    service: "openshare-cf",
    storage: "r2",
    catalogReady: Boolean(catalogObject),
    catalogUploadedAt: catalogObject?.uploaded?.toISOString?.() ?? null,
    siteTitle: env.SITE_TITLE || "OpenShare CF 容灾镜像",
  });
}

async function handleCatalog(request, env) {
  const url = new URL(request.url);
  const forceLive = url.searchParams.get("live") === "1";

  if (!forceLive) {
    const catalogObject = await env.FILES.get(CATALOG_KEY);
    if (catalogObject?.body) {
      const headers = new Headers();
      catalogObject.writeHttpMetadata(headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "public, max-age=60, stale-while-revalidate=300");
      headers.set("etag", catalogObject.httpEtag);
      headers.set("x-openshare-catalog-source", "snapshot");
      return new Response(catalogObject.body, { headers });
    }
  }

  const limit = normalizeLimit(env.AUTO_INDEX_LIMIT);
  const catalog = await buildCatalog(env.FILES, limit);
  return json(catalog, 200, {
    "cache-control": "no-store",
    "x-openshare-catalog-source": "live",
  });
}

async function handleReindex(request, env) {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN is not configured; reindex API is disabled." }, 503);
  }

  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }

  const limit = normalizeLimit(env.AUTO_INDEX_LIMIT);
  const catalog = await buildCatalog(env.FILES, limit);
  const body = JSON.stringify(catalog);

  await env.FILES.put(CATALOG_KEY, body, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-cache",
    },
    customMetadata: {
      generatedBy: "openshare-cf",
      generatedAt: catalog.generatedAt,
    },
  });

  return json({
    ok: true,
    key: CATALOG_KEY,
    files: catalog.stats.files,
    bytes: catalog.stats.bytes,
    generatedAt: catalog.generatedAt,
    truncated: catalog.truncated,
  });
}

async function handleDownload(request, env, pathname) {
  let key;
  try {
    key = decodeURIComponent(pathname.slice("/download/".length));
  } catch {
    return new Response("Bad file path", { status: 400 });
  }

  if (!key || key.startsWith(INTERNAL_PREFIX)) {
    return new Response("Not found", { status: 404 });
  }

  const object = await env.FILES.get(key, {
    onlyIf: request.headers,
    range: request.headers,
  });

  if (object === null) {
    return new Response("File not found", { status: 404 });
  }

  if (!object.body) {
    return new Response(null, { status: 412 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=3600");
  headers.set("content-disposition", contentDisposition(fileNameFromKey(key)));

  let status = 200;
  if (request.headers.has("range") && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(object.size));
  }

  return new Response(object.body, { status, headers });
}

async function buildCatalog(bucket, maxFiles) {
  const files = [];
  let cursor;
  let truncated = false;

  while (files.length < maxFiles) {
    const page = await bucket.list({
      cursor,
      limit: Math.min(1000, maxFiles - files.length),
      include: ["httpMetadata", "customMetadata"],
    });

    for (const object of page.objects) {
      if (object.key.startsWith(INTERNAL_PREFIX)) continue;
      files.push(toCatalogEntry(object));
      if (files.length >= maxFiles) break;
    }

    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;

    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
  }

  files.sort((a, b) => a.key.localeCompare(b.key, "zh-CN"));

  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const categories = [...new Set(files.map((file) => file.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN")
  );

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    source: "r2",
    truncated,
    limit: maxFiles,
    stats: {
      files: files.length,
      bytes,
      categories: categories.length,
    },
    categories,
    files,
  };
}

function toCatalogEntry(object) {
  const key = object.key;
  const parts = key.split("/").filter(Boolean);
  const name = parts.at(-1) || key;
  const folder = parts.slice(0, -1).join("/");
  const extension = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  const category = parts.length > 1 ? parts[0] : "未分类";

  return {
    key,
    name,
    folder,
    category,
    extension,
    size: object.size,
    uploaded: object.uploaded?.toISOString?.() ?? null,
    etag: object.etag,
    contentType: object.httpMetadata?.contentType || null,
    downloadUrl: `/download/${encodeURIComponent(key)}`,
  };
}

function fileNameFromKey(key) {
  return key.split("/").filter(Boolean).at(-1) || "download";
}

function contentDisposition(filename) {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${asciiFallback(safe)}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function asciiFallback(value) {
  const cleaned = value.replace(/[^\x20-\x7E]/g, "_");
  return cleaned || "download";
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value || "20000", 10);
  if (!Number.isFinite(parsed)) return 20000;
  return Math.min(Math.max(parsed, 100), 50000);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
