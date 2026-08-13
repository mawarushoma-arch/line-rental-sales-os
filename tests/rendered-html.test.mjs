import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
const clientRoot = path.join(projectRoot, "dist", "client");
const workerPath = path.join(projectRoot, "dist", "server", "index.js");
const standalonePreviewPath = path.join(projectRoot, "dist", "room-pilot-preview.html");
const standalonePreviewOgPath = path.join(projectRoot, "dist", "og.png");

const workerUrl = pathToFileURL(workerPath);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const domain = await import(pathToFileURL(path.join(publicRoot, "domain.mjs")).href);
const adapters = await import(pathToFileURL(path.join(publicRoot, "api-adapter.mjs")).href);
const apiContract = await import(pathToFileURL(path.join(publicRoot, "model-contract.mjs")).href);

async function fetchBuilt(pathname, accept = "*/*") {
  return worker.fetch(
    new Request(`https://room-pilot.test${pathname}`, {
      headers: { accept },
    }),
  );
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }

  return files.sort();
}

test("Workerが埋め込みHTMLを / で返す", async () => {
  const response = await fetchBuilt("/", "text/html");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html\b[^>]*\blang=["']ja["']/i);
  assert.match(html, /<title[^>]*>[^<]*(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[^<]*<\/title>/iu);
  assert.match(html, /ROOM\s*PILOT/i);
  assert.match(html, /<img[^>]+class="brand-logo"[^>]*>/i, "ヘッダーに公式アカウントのロゴが必要です");

  for (const label of ["顧客", "物件", "今日", "内見", "案件"]) {
    assert.match(html, new RegExp(label), `5タブの「${label}」が必要です`);
  }

  const tabMarkers = html.match(/\b(?:data-tab|role=["']tab["'])\b/gi) ?? [];
  assert.ok(tabMarkers.length >= 5, "5つのタブ構造が必要です");
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Codex is working/i);
});

test("公開ファイルを再帰的に dist\/client へ同一内容でコピーする", async () => {
  const publicFiles = await listFiles(publicRoot);
  const clientFiles = await listFiles(clientRoot);
  assert.deepEqual(clientFiles, publicFiles);

  for (const relativePath of publicFiles) {
    const [source, built] = await Promise.all([
      readFile(path.join(publicRoot, relativePath)),
      readFile(path.join(clientRoot, relativePath)),
    ]);
    assert.deepEqual(built, source, `${relativePath} のビルド結果が異なります`);
  }
});

test("LINE未接続の単体Webプレビューをサーバーなしで開ける", async () => {
  const html = await readFile(standalonePreviewPath, "utf8");
  assert.match(html, /<style>[\s\S]*\.bottom-nav/u);
  assert.match(html, /<script type="module">[\s\S]*ROOM PILOT/u);
  assert.doesNotMatch(html, /(?:src="\/app\.js"|href="\/styles\.css"|^\s*import\s)/mu);
  assert.match(html, /window\.location\.protocol === "file:" \? "employee"/u);
  assert.match(html, /transport: async \(\) => new Response\(JSON\.stringify\(MOCK_BOOTSTRAP_PAYLOAD\)/u);
  for (const label of ["顧客", "物件", "今日", "内見", "案件"]) assert.match(html, new RegExp(label));
  const ogBytes = await readFile(standalonePreviewOgPath);
  assert.deepEqual([...ogBytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("WorkerがOG画像も ASSETS なしで返す", async () => {
  const response = await fetchBuilt("/og.png", "image/png");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/png\b/i);

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 8, "OG画像が空ではいけません");
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("API骨格が接続状態と正規化モデル契約を返す", async () => {
  const [healthResponse, bootstrapResponse] = await Promise.all([
    fetchBuilt("/api/health", "application/json"),
    fetchBuilt("/api/mock/bootstrap", "application/json"),
  ]);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    service: "room-pilot-mock",
    apiConnected: false,
  });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.source, "mock");
  assert.deepEqual(bootstrap.normalizedModels, [
    "Customer",
    "Property",
    "SearchCondition",
    "CandidateProperty",
    "Viewing",
    "Case",
    "TodayAction",
    "DisplayPreference",
  ]);
  assert.deepEqual(bootstrap.modelContracts, apiContract.NORMALIZED_MODEL_CONTRACTS);
  for (const [model, fields] of Object.entries(bootstrap.modelContracts)) {
    assert.ok(fields.length >= 4, `${model} の実行可能な形状契約が必要です`);
  }

  const headResponse = await worker.fetch(new Request("https://room-pilot.test/api/health", {
    method: "HEAD",
  }));
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");

  const rejectedWrite = await worker.fetch(new Request("https://room-pilot.test/api/health", {
    method: "POST",
  }));
  assert.equal(rejectedWrite.status, 405);
  assert.equal(rejectedWrite.headers.get("allow"), "GET, HEAD");
});

test("CSSがダーク表示・動きの抑制・セーフエリアに対応する", async () => {
  const response = await fetchBuilt("/styles.css", "text/css");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/css\b/i);

  const css = await response.text();
  assert.match(css, /prefers-color-scheme\s*:\s*dark|\[data-theme=["']?dark|\.dark\b/i);
  assert.match(css, /prefers-reduced-motion\s*:\s*reduce/i);
  assert.match(css, /env\(\s*safe-area-inset-(?:top|right|bottom|left)/i);
  assert.match(css, /max-width:\s*480px/i);
  assert.match(css, /@media\s*\(max-width:\s*374px\)/i);
  assert.match(css, /min-(?:width|height):\s*44px/i);
  assert.doesNotMatch(css, /codex-preview/i);
});

test("JSが3権限状態とスワイプ・Undo・ローカル保存を備える", async () => {
  const response = await fetchBuilt("/app.js", "text/javascript");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^(?:text|application)\/javascript\b/i);

  const js = await response.text();
  assert.match(js, /URLSearchParams/);
  assert.match(js, /(?:get\(["']role["']\)|\brole\b)/i);
  for (const role of ["employee", "pending", "customer"]) {
    assert.match(js, new RegExp(`\\b${role}\\b`), `role=${role} のガードが必要です`);
  }
  assert.match(js, /access[-_ ]?gate|role[-_ ]?guard|guardRole|renderAccess/i);
  // LIFFはクエリを liff.state に畳んで渡す。展開しないと社員でも制限画面になる
  assert.match(js, /liff\.state/, "liff.state の展開が必要です");

  assert.match(js, /pointerdown/i);
  assert.match(js, /pointermove/i);
  assert.match(js, /swipe/i);
  // カード幅・高さに対する比でスワイプ成立を判定する（横=前後送り／下=保存）
  assert.match(js, /0?\.2[0-9]\b/, "スワイプ成立のしきい値が必要です");
  assert.match(js, /undo/i);
  assert.match(js, /UNDO_SECONDS\s*=\s*\d+/, "Undoの猶予秒を定数で持つ必要があります");

  assert.match(js, /localStorage/);
  assert.match(js, /\.getItem\s*\(/);
  assert.match(js, /\.setItem\s*\(/);
  assert.match(js, /JSON\.parse\s*\(/);
  assert.match(js, /JSON\.stringify\s*\(/);
  assert.match(js, /room[-_: ]?pilot|STORAGE[_A-Z]*KEY/i);
  assert.doesNotMatch(js, /codex-preview/i);
});

test("20件の連続判断・Undo・顧客分離が純粋状態遷移で保たれる", () => {
  let decisions = {};
  let lastUndo = null;
  for (let index = 1; index <= 20; index += 1) {
    const result = domain.applyPropertyDecision(
      decisions,
      "customer-a",
      `property-${index}`,
      index % 2 ? "liked" : "skipped",
    );
    decisions = result.decisions;
    lastUndo = result.undo;
  }
  assert.equal(decisions["customer-a"].liked.length, 10);
  assert.equal(decisions["customer-a"].skipped.length, 10);
  assert.equal(decisions["customer-b"], undefined);

  const undone = domain.undoPropertyDecision(decisions, lastUndo);
  assert.equal(undone.restored, true);
  assert.equal(undone.decisions["customer-a"].skipped.length, 9);
  assert.equal(
    domain.effectiveCandidateStatus("liked", undone.decisions["customer-a"], "property-20"),
    "liked",
    "local undo後はadapterのseed状態へ戻る",
  );
});

test("表示順変更と案件ステージ後退防止の契約を守る", () => {
  assert.deepEqual(domain.moveItem(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(domain.moveItem(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.equal(domain.stageAtOrBeyond("契約準備", "申込準備"), true);
  assert.equal(domain.stageAtOrBeyond("内見調整", "申込準備"), false);
  assert.equal(domain.isKnownCaseStage("契約済"), true);
  assert.equal(domain.isKnownCaseStage("失注"), false);
  assert.equal(domain.effectiveCandidateStatus("reserved", {}, "property-a"), "reserved");
  assert.equal(domain.containsInternalFragment("鍵メモ B-12 を送る", ["鍵メモ B-12"]), true);
  assert.equal(domain.containsInternalFragment("鍵はB-12です", ["社内キーボックス B-12 / 暗証情報は表示しません"]), true);
  assert.equal(domain.containsInternalFragment("鍵はB12です", ["社内キーボックス B-12 / 暗証情報は表示しません"]), true);
  assert.equal(domain.containsInternalFragment("鍵はB 12です", ["社内キーボックス B-12 / 暗証情報は表示しません"]), true);
  assert.equal(domain.containsInternalFragment("ADは200です", ["AD 200"]), true);
  assert.equal(domain.containsInternalFragment("ADが200です", ["AD 200"]), true);
  assert.equal(domain.containsInternalFragment("公開情報だけです", ["鍵メモ B-12"]), false);
  assert.ok(domain.validateNormalizedModels({}).length > 0);
});

test("正規化モデルは更新日時欠損を鮮度不明として許容し、不正日時だけ拒否する", () => {
  const models = {
    Customer: [{ id: "c1", status: "新規", lastContactAt: "2026-08-11T11:00:00+09:00", searchConditionId: "sc1" }],
    Property: [{
      id: "p1",
      listedAt: "2026-08-11T09:00:00+09:00",
      fetchedAt: "2026-08-11T11:20:00+09:00",
      rentYen: 100_000,
      managementFeeYen: 5_000,
      internal: {},
    }],
    SearchCondition: [{
      id: "sc1",
      customerId: "c1",
      updatedAt: "2026-08-11T11:20:00+09:00",
      items: [{ key: "area", label: "エリア", value: "目黒", status: "confirmed" }],
    }],
    CandidateProperty: [{
      id: "cp1",
      customerId: "c1",
      propertyId: "p1",
      status: "unreviewed",
      matchScore: 90,
      matchReasons: ["希望沿線"],
    }],
    Viewing: [{ id: "v1", customerId: "c1", propertyId: "p1" }],
    Case: [{
      id: "case1",
      customerId: "c1",
      propertyId: "p1",
      stage: "追客中",
      dueAt: "2026-08-12T10:00:00+09:00",
      updatedAt: "2026-08-11T11:00:00+09:00",
    }],
    TodayAction: [{
      id: "ta1",
      customerId: "c1",
      dueAt: "2026-08-11T12:00:00+09:00",
      status: "todo",
    }],
    DisplayPreference: {
      salesUserId: "employee:sato",
      widgets: ["priority"],
      propertyFields: ["listing"],
      updatedAt: "2026-08-11T11:20:00+09:00",
    },
  };
  assert.deepEqual(domain.validateNormalizedModels(models), []);
  models.Property[0].sourceUpdatedAt = "not-a-date";
  assert.match(domain.validateNormalizedModels(models).join(" "), /Property p1/);
});

test("Adapterがloading後のstale・empty・errorと返信許可リストを区別する", async () => {
  const transport = async () => new Response(JSON.stringify(apiContract.MOCK_BOOTSTRAP_PAYLOAD), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const stale = await new adapters.MockRentalDataAdapter({
    search: "?api=stale",
    delayMs: 0,
    transport,
  }).bootstrap();
  const empty = await new adapters.MockRentalDataAdapter({
    search: "?api=empty",
    delayMs: 0,
    transport,
  }).bootstrap();
  assert.equal(stale.stale, true);
  assert.equal(empty.empty, true);
  await assert.rejects(
    new adapters.MockRentalDataAdapter({
      search: "?api=error",
      delayMs: 0,
      transport,
    }).bootstrap(),
    (error) => error.code === "NETWORK" && error.retryable === true,
  );
  await assert.rejects(
    new adapters.MockRentalDataAdapter({
      delayMs: 0,
      timeoutMs: 15,
      transport: async () => new Promise(() => {}),
    }).bootstrap(),
    (error) => error.code === "TIMEOUT" && error.retryable === true,
  );
  await assert.rejects(
    new adapters.MockRentalDataAdapter({
      delayMs: 0,
      transport: async () => new Response(null, { status: 403 }),
    }).bootstrap(),
    (error) => error.code === "AUTH" && error.retryable === false,
  );
  await assert.rejects(
    new adapters.MockRentalDataAdapter({
      delayMs: 0,
      transport: async () => Response.json({ ok: true, source: "unexpected" }),
    }).bootstrap(),
    (error) => error.code === "CONTRACT" && error.retryable === false,
  );
  await assert.rejects(
    new adapters.MockRentalDataAdapter({
      delayMs: 0,
      transport: async () => Response.json({
        ok: true,
        source: "mock",
        normalizedModels: Object.keys(apiContract.NORMALIZED_MODEL_CONTRACTS),
        modelContracts: Object.fromEntries(
          Object.keys(apiContract.NORMALIZED_MODEL_CONTRACTS).map((model) => [model, []]),
        ),
      }),
    }).bootstrap(),
    (error) => error.code === "CONTRACT" && error.retryable === false,
  );

  const gateway = new adapters.MockApprovedReplyGateway();
  assert.equal(gateway.sendCount, 0, "明示承認前の送信は0件");
  assert.throws(
    () => adapters.createApprovedReplyDTO({
      customerId: "customer-a",
      draftId: "draft-a",
      body: "未承認本文",
    }),
    (error) => error.code === "UNAPPROVED_REPLY",
  );
  const approval = adapters.createMockReplyApproval({
    draftId: "draft-a",
    body: "公開情報だけの返信です。",
    approvedBy: "employee:sato",
  });
  assert.throws(
    () => adapters.createApprovedReplyDTO({
      customerId: "customer-a",
      draftId: "draft-a",
      body: "承認後に変更した本文",
      approval,
    }),
    (error) => error.code === "UNAPPROVED_REPLY",
  );
  const dto = adapters.createApprovedReplyDTO({
    customerId: "customer-a",
    draftId: "draft-a",
    body: "  公開情報だけの返信です。  ",
    approval,
  });
  assert.deepEqual(Object.keys(dto).sort(), ["approvedAt", "approvedBy", "body", "bodyFingerprint", "customerId", "draftId"]);
  assert.equal(dto.body, "公開情報だけの返信です。");
  assert.equal("ad" in dto || "keyInfo" in dto || "managementCompanyNote" in dto, false);
  await gateway.sendApprovedReply(dto);
  assert.equal(gateway.sendCount, 1);
});

test("Workerが未知のパスを ASSETS バインディングへ委譲できる", async () => {
  const response = await worker.fetch(new Request("https://room-pilot.test/external.txt"), {
    ASSETS: {
      fetch() {
        return new Response("adapter asset", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "adapter asset");
});
