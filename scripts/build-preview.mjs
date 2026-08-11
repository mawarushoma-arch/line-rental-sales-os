import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
const outputPath = path.join(projectRoot, "dist", "room-pilot-preview.html");

const [html, css, modelContract, domain, adapter, app] = await Promise.all([
  readFile(path.join(publicRoot, "index.html"), "utf8"),
  readFile(path.join(publicRoot, "styles.css"), "utf8"),
  readFile(path.join(publicRoot, "model-contract.mjs"), "utf8"),
  readFile(path.join(publicRoot, "domain.mjs"), "utf8"),
  readFile(path.join(publicRoot, "api-adapter.mjs"), "utf8"),
  readFile(path.join(publicRoot, "app.js"), "utf8"),
]);

function removeImports(source) {
  const importPattern = /^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*/u;
  let result = source;
  while (importPattern.test(result)) result = result.replace(importPattern, "");
  return result;
}

function removeExports(source) {
  return source.replace(/^export\s+/gmu, "");
}

function replaceExactOnce(source, search, replacement, label) {
  const firstIndex = source.indexOf(search);
  const secondIndex = firstIndex < 0 ? -1 : source.indexOf(search, firstIndex + search.length);
  if (firstIndex < 0 || secondIndex >= 0) {
    throw new Error(`${label}: expected exactly one source marker`);
  }
  return `${source.slice(0, firstIndex)}${replacement}${source.slice(firstIndex + search.length)}`;
}

function replaceExactCount(source, search, replacement, expectedCount, label) {
  const actualCount = source.split(search).length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(`${label}: expected ${expectedCount} source markers, found ${actualCount}`);
  }
  return source.replaceAll(search, replacement);
}

const standaloneAppWithRole = replaceExactOnce(
  removeImports(app),
  'const role = new URLSearchParams(window.location.search).get("role") || "customer";',
  'const role = new URLSearchParams(window.location.search).get("role") || (window.location.protocol === "file:" ? "employee" : "customer");',
  "standalone role guard",
);
const standaloneApp = replaceExactOnce(
  standaloneAppWithRole,
  "const dataAdapter = createRentalDataAdapter();",
  `const dataAdapter = createRentalDataAdapter(window.location.protocol === "file:" ? {
    transport: async () => new Response(JSON.stringify(MOCK_BOOTSTRAP_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  } : undefined);`,
  "standalone mock transport",
);

const bundle = [
  removeExports(modelContract),
  removeExports(domain),
  removeExports(removeImports(adapter)),
  standaloneApp,
].join("\n\n").replaceAll("</script", "<\\/script");

// Parse the concatenated script before writing the handoff file.
new Function(bundle);

const htmlWithStyles = replaceExactOnce(
  html,
  '<link rel="stylesheet" href="/styles.css" />',
  `<style>\n${css}\n</style>`,
  "inline stylesheet",
);
const htmlWithBundle = replaceExactOnce(
  htmlWithStyles,
  '<script type="module" src="/app.js"></script>',
  `<script type="module">\n${bundle}\n</script>`,
  "inline application bundle",
);
const previewHtml = replaceExactCount(htmlWithBundle, 'content="/og.png"', 'content="./og.png"', 2, "OG metadata");

await mkdir(path.dirname(outputPath), { recursive: true });
await Promise.all([
  writeFile(outputPath, previewHtml, "utf8"),
  copyFile(path.join(publicRoot, "og.png"), path.join(path.dirname(outputPath), "og.png")),
]);

console.log(`Standalone UI preview: ${outputPath}`);
