import { access, readFile } from "node:fs/promises";

const required = [
  "wrangler.jsonc",
  "src/index.js",
  "public/index.html",
  "public/app.js",
  "public/assets/site.css",
  "README.md",
];

for (const file of required) {
  await access(file);
}

const worker = await readFile("src/index.js", "utf8");
for (const endpoint of ["/api/catalog", "/api/admin/reindex", "/download/"]) {
  if (!worker.includes(endpoint)) throw new Error(`Missing endpoint: ${endpoint}`);
}

console.log("Project structure check passed.");
