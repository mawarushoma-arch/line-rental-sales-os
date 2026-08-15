import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_BOOTSTRAP_PAYLOAD, MOCK_HEALTH_PAYLOAD } from "../public/model-contract.mjs";
import { handleLineRequest } from "../worker/line-bridge.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
const host = process.env.HOST || "127.0.0.1";
const parsedPort = Number.parseInt(process.env.PORT || "4173", 10);

if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const contentTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendText(response, statusCode, message, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  response.end(message);
}

function sendJson(response, statusCode, payload, method = "GET") {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(method === "HEAD" ? undefined : body);
}

/**
 * ローカル確認用のKV代わり。プロセスを落とすと消えるので、残す必要のある確認は本番Workerで行う。
 * KVと同じく、キーはバイト順で並べる。
 */
function createMemoryStore() {
  const entries = new Map();
  const alive = (entry) => !entry.expiresAt || entry.expiresAt > Date.now();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (!alive(entry)) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options = {}) {
      const ttl = Number(options.expirationTtl) || 0;
      entries.set(key, { value: String(value), expiresAt: ttl ? Date.now() + ttl * 1000 : 0 });
    },
    async delete(key) {
      entries.delete(key);
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...entries.entries()]
        .filter(([name, entry]) => name.startsWith(prefix) && alive(entry))
        .map(([name]) => ({ name }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .slice(0, limit);
      return { keys, list_complete: true };
    },
  };
}

// `.dev.vars` があれば読む。無くても起動はする（LINE経路だけが未設定として断る）
try {
  process.loadEnvFile(path.join(projectRoot, ".dev.vars"));
} catch {
  // 未作成なら何もしない
}

const lineEnv = {
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || "",
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  ROOM_PILOT_LINE_KEY: process.env.ROOM_PILOT_LINE_KEY || "",
  LINE_STORE: createMemoryStore(),
};

async function toWebRequest(request) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: request.method, headers, body });
}

async function sendWebResponse(response, webResponse) {
  const buffer = Buffer.from(await webResponse.arrayBuffer());
  const headers = {};
  webResponse.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers["content-length"] = buffer.byteLength;
  response.writeHead(webResponse.status, headers);
  response.end(buffer);
}

function safeFilePath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return null;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolutePath = path.resolve(publicRoot, relativePath);
  if (absolutePath !== publicRoot && !absolutePath.startsWith(`${publicRoot}${path.sep}`)) {
    return null;
  }
  return absolutePath;
}

const server = createServer(async (request, response) => {
  const requestPath = new URL(request.url || "/", "http://localhost").pathname;

  if (requestPath === "/line/webhook" || requestPath.startsWith("/api/line/")) {
    try {
      const lineResponse = await handleLineRequest(await toWebRequest(request), lineEnv);
      if (lineResponse) {
        await sendWebResponse(response, lineResponse);
        return;
      }
    } catch (error) {
      sendText(response, 500, `LINE bridge error: ${error.message}`);
      return;
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed", { allow: "GET, HEAD" });
    return;
  }

  if (requestPath === "/api/health") {
    sendJson(response, 200, MOCK_HEALTH_PAYLOAD, request.method);
    return;
  }
  if (requestPath === "/api/mock/bootstrap") {
    sendJson(response, 200, MOCK_BOOTSTRAP_PAYLOAD, request.method);
    return;
  }

  let filePath = safeFilePath(request.url || "/");
  if (!filePath) {
    sendText(response, 400, "Bad Request");
    return;
  }

  let fileStats = await stat(filePath).catch(() => null);
  if (fileStats?.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    fileStats = await stat(filePath).catch(() => null);
  }

  if (!fileStats?.isFile()) {
    sendText(response, 404, "Not Found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
    "content-length": fileStats.size,
    "cache-control": "no-cache",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) sendText(response, 500, "Internal Server Error");
    else response.destroy();
  });
  stream.pipe(response);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(parsedPort, host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : parsedPort;
  console.log(`ROOM PILOT dev server: http://${host}:${port}/`);
});

function closeServer() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", closeServer);
process.once("SIGTERM", closeServer);
