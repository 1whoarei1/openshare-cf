const CATALOG_KEY = "_meta/catalog.json";
const INTERNAL_PREFIX = "_meta/";
const TAR_BLOCK_SIZE = 512;
const FOLDER_DOWNLOAD_MAX_FILES = 20000;
const textEncoder = new TextEncoder();

const R2_FREE_QUOTA = {
  classA: 1_000_000,
  classB: 10_000_000,
};

const CLASS_A_ACTIONS = new Set([
  "listbuckets",
  "putbucket",
  "listobjects",
  "putobject",
  "copyobject",
  "completemultipartupload",
  "createmultipartupload",
  "lifecyclestoragetiertransition",
  "listmultipartuploads",
  "uploadpart",
  "uploadpartcopy",
  "listparts",
  "putbucketencryption",
  "putbucketcors",
  "putbucketlifecycleconfiguration",
]);

const CLASS_B_ACTIONS = new Set([
  "headbucket",
  "headobject",
  "getobject",
  "usagesummary",
  "getbucketencryption",
  "getbucketlocation",
  "getbucketcors",
  "getbucketlifecycleconfiguration",
]);

const FREE_ACTIONS = new Set([
  "deleteobject",
  "deletebucket",
  "abortmultipartupload",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status" && request.method === "GET") {
      return handleStatus(env);
    }

    if (url.pathname === "/api/catalog" && request.method === "GET") {
      return handleCatalog(request, env);
    }

    if (url.pathname === "/api/r2-usage" && request.method === "GET") {
      return handleR2Usage(env);
    }

    if (url.pathname === "/api/admin/reindex" && request.method === "POST") {
      return handleReindex(request, env);
    }

    if (url.pathname.startsWith("/download-folder/") && request.method === "GET") {
      return handleFolderDownload(env, url.pathname);
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
    analyticsConfigured: Boolean(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN),
    folderDownload: "streaming-tar",
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

async function handleR2Usage(env) {
  const bucketName = env.R2_BUCKET_NAME || "openshare-cf-files";
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));

  const base = {
    configured: Boolean(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN),
    bucketName,
    period: {
      start: monthStart.toISOString(),
      end: now.toISOString(),
    },
    freeQuota: R2_FREE_QUOTA,
  };

  if (!base.configured) {
    return json({
      ...base,
      account: null,
      bucket: null,
      note: "Configure CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN to show live Cloudflare Analytics usage.",
    }, 200, { "cache-control": "public, max-age=300" });
  }

  const query = `
    query R2MonthlyUsage(
      $accountTag: string!
      $startDate: Time
      $endDate: Time
      $bucketName: string
    ) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          accountOps: r2OperationsAdaptiveGroups(
            limit: 10000
            filter: {
              datetime_geq: $startDate
              datetime_leq: $endDate
            }
          ) {
            sum { requests }
            dimensions { actionType }
          }
          bucketOps: r2OperationsAdaptiveGroups(
            limit: 10000
            filter: {
              datetime_geq: $startDate
              datetime_leq: $endDate
              bucketName: $bucketName
            }
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: env.CF_ACCOUNT_ID,
          startDate: monthStart.toISOString(),
          endDate: now.toISOString(),
          bucketName,
        },
      }),
    });

    const payload = await response.json();

    if (!response.ok || payload.errors?.length) {
      const message =
        payload.errors?.map((item) => item.message).filter(Boolean).join("; ") ||
        `Cloudflare Analytics HTTP ${response.status}`;
      throw new Error(message);
    }

    const accountNode = payload.data?.viewer?.accounts?.[0];
    if (!accountNode) {
      throw new Error("No Analytics account data returned.");
    }

    const account = summarizeOperations(accountNode.accountOps || []);
    const bucket = summarizeOperations(accountNode.bucketOps || []);

    return json({
      ...base,
      account: withQuota(account),
      bucket,
      analyticsUpdatedAt: now.toISOString(),
      note: "Usage comes from Cloudflare GraphQL Analytics. Free allowance is account-level and resets monthly.",
    }, 200, { "cache-control": "public, max-age=300" });
  } catch (error) {
    return json({
      ...base,
      account: null,
      bucket: null,
      error: String(error?.message || error),
    }, 502, { "cache-control": "no-store" });
  }
}

function summarizeOperations(groups) {
  const summary = {
    classA: 0,
    classB: 0,
    free: 0,
    unknown: 0,
    total: 0,
    actions: {},
  };

  for (const group of groups) {
    const actionType = String(group?.dimensions?.actionType || "Unknown");
    const requests = Number(group?.sum?.requests || 0);
    const normalized = actionType.toLowerCase();

    summary.total += requests;
    summary.actions[actionType] = (summary.actions[actionType] || 0) + requests;

    if (CLASS_A_ACTIONS.has(normalized)) {
      summary.classA += requests;
    } else if (CLASS_B_ACTIONS.has(normalized)) {
      summary.classB += requests;
    } else if (FREE_ACTIONS.has(normalized)) {
      summary.free += requests;
    } else {
      summary.unknown += requests;
    }
  }

  return summary;
}

function withQuota(summary) {
  return {
    ...summary,
    classARemaining: Math.max(0, R2_FREE_QUOTA.classA - summary.classA),
    classBRemaining: Math.max(0, R2_FREE_QUOTA.classB - summary.classB),
    classAPercent: percentage(summary.classA, R2_FREE_QUOTA.classA),
    classBPercent: percentage(summary.classB, R2_FREE_QUOTA.classB),
  };
}

function percentage(value, total) {
  if (!total) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
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

async function handleFolderDownload(env, pathname) {
  let folderPath;

  try {
    folderPath = decodeURIComponent(pathname.slice("/download-folder/".length));
  } catch {
    return new Response("Bad folder path", { status: 400 });
  }

  folderPath = normalizeObjectPath(folderPath);

  if (!folderPath || folderPath.startsWith(INTERNAL_PREFIX)) {
    return new Response("Folder not found", { status: 404 });
  }

  const prefix = `${folderPath}/`;
  let objects;

  try {
    objects = await listFolderObjects(env.FILES, prefix, FOLDER_DOWNLOAD_MAX_FILES);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 413);
  }

  if (objects.length === 0) {
    return new Response("Folder is empty or does not exist", { status: 404 });
  }

  const parentPrefix = folderPath.includes("/")
    ? folderPath.slice(0, folderPath.lastIndexOf("/") + 1)
    : "";

  const folderName = folderPath.split("/").filter(Boolean).at(-1) || "folder";
  const archiveName = `${folderName}.tar`;
  const tarStream = createTarStream(env.FILES, objects, parentPrefix);

  return new Response(tarStream, {
    headers: {
      "content-type": "application/x-tar",
      "content-disposition": contentDisposition(archiveName),
      "cache-control": "private, no-store",
      "x-openshare-folder-files": String(objects.length),
    },
  });
}

async function listFolderObjects(bucket, prefix, maxFiles) {
  const objects = [];
  let cursor;

  while (true) {
    const page = await bucket.list({
      prefix,
      cursor,
      limit: 1000,
    });

    for (const object of page.objects) {
      if (object.key.startsWith(INTERNAL_PREFIX)) continue;
      if (object.key.endsWith("/") && object.size === 0) continue;

      objects.push({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded,
      });

      if (objects.length > maxFiles) {
        throw new Error(`Folder contains more than ${maxFiles} files; split the download into smaller folders.`);
      }
    }

    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }

  objects.sort((a, b) => a.key.localeCompare(b.key, "zh-CN", { numeric: true }));
  return objects;
}

function createTarStream(bucket, objects, stripPrefix) {
  const { readable, writable } = new TransformStream();

  (async () => {
    try {
      for (let index = 0; index < objects.length; index += 1) {
        const metadata = objects[index];
        const archivePath = metadata.key.slice(stripPrefix.length);
        const modified = metadata.uploaded ? new Date(metadata.uploaded) : new Date();

        const paxBody = makePaxBody({
          path: archivePath,
          mtime: String(modified.getTime() / 1000),
        });

        const paxName = `PaxHeaders/${String(index + 1).padStart(6, "0")}`;
        await writeToStream(
          writable,
          createTarHeader({
            name: paxName,
            size: paxBody.byteLength,
            mtime: modified,
            type: "x",
          })
        );
        await writeToStream(writable, paxBody);
        await writeTarPadding(writable, paxBody.byteLength);

        const object = await bucket.get(metadata.key);
        if (!object?.body) {
          throw new Error(`R2 object disappeared during archive creation: ${metadata.key}`);
        }

        await writeToStream(
          writable,
          createTarHeader({
            name: `file-${String(index + 1).padStart(6, "0")}`,
            size: object.size,
            mtime: modified,
            type: "0",
          })
        );

        await object.body.pipeTo(writable, { preventClose: true });
        await writeTarPadding(writable, object.size);
      }

      await writeToStream(writable, new Uint8Array(TAR_BLOCK_SIZE * 2));

      const writer = writable.getWriter();
      await writer.close();
      writer.releaseLock();
    } catch (error) {
      try {
        const writer = writable.getWriter();
        await writer.abort(error);
        writer.releaseLock();
      } catch {
        // Client disconnect or stream already closed.
      }
    }
  })();

  return readable;
}

function makePaxBody(fields) {
  let text = "";

  for (const [key, value] of Object.entries(fields)) {
    text += makePaxRecord(key, value);
  }

  return textEncoder.encode(text);
}

function makePaxRecord(key, value) {
  const payload = ` ${key}=${value}\n`;
  const payloadLength = textEncoder.encode(payload).byteLength;
  let length = payloadLength + 1;

  while (true) {
    const next = payloadLength + String(length).length;
    if (next === length) break;
    length = next;
  }

  return `${length}${payload}`;
}

function createTarHeader({ name, size, mtime, type }) {
  const header = new Uint8Array(TAR_BLOCK_SIZE);

  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor((mtime?.getTime?.() || Date.now()) / 1000));

  header.fill(0x20, 148, 156);
  header[156] = String(type || "0").charCodeAt(0);

  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  writeAscii(header, 265, 32, "openshare");
  writeAscii(header, 297, 32, "openshare");

  let checksum = 0;
  for (const byte of header) checksum += byte;

  const checksumText = checksum.toString(8).padStart(6, "0");
  writeAscii(header, 148, 8, `${checksumText}\0 `);

  return header;
}

function writeAscii(buffer, offset, length, value) {
  const bytes = textEncoder.encode(String(value || ""));
  buffer.set(bytes.slice(0, length), offset);
}

function writeOctal(buffer, offset, length, value) {
  const safe = Math.max(0, Number(value) || 0);
  const text = Math.floor(safe).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeAscii(buffer, offset, length, `${text}\0`);
}

async function writeToStream(writable, bytes) {
  if (!bytes?.byteLength) return;
  const writer = writable.getWriter();

  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

async function writeTarPadding(writable, size) {
  const remainder = Number(size) % TAR_BLOCK_SIZE;
  if (remainder === 0) return;
  await writeToStream(writable, new Uint8Array(TAR_BLOCK_SIZE - remainder));
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

function normalizeObjectPath(path) {
  return String(path || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
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
