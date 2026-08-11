import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_BOOTSTRAP_PAYLOAD, MOCK_HEALTH_PAYLOAD } from "../public/model-contract.mjs";

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
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed", { allow: "GET, HEAD" });
    return;
  }

  const requestPath = new URL(request.url || "/", "http://localhost").pathname;
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
