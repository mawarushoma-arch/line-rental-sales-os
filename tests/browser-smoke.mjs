import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalonePreviewPath = path.join(projectRoot, "dist", "room-pilot-preview.html");
const builtWorkerPath = path.join(projectRoot, "dist", "server", "index.js");
const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePath = process.env.CHROME_PATH || defaultChromePath;
const commandTimeoutMs = 12_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const builtWorkerUrl = pathToFileURL(builtWorkerPath);
builtWorkerUrl.searchParams.set("browser-smoke", `${process.pid}-${Date.now()}`);
const { default: builtWorker } = await import(builtWorkerUrl.href);

class PipeCdpClient {
  constructor(child) {
    this.child = child;
    this.writer = child.stdio[3];
    this.reader = child.stdio[4];
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.exitInfo = null;

    this.reader.on("data", (chunk) => this.consume(chunk));
    this.reader.on("error", (error) => this.rejectAll(error));
    child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.rejectAll(new Error(`Chrome exited before CDP completed (code=${code}, signal=${signal})`));
    });
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let boundary = this.buffer.indexOf(0);
    while (boundary !== -1) {
      const frame = this.buffer.subarray(0, boundary).toString("utf8").trim();
      this.buffer = this.buffer.subarray(boundary + 1);
      if (frame) {
        try {
          this.dispatch(JSON.parse(frame));
        } catch (error) {
          this.rejectAll(new Error(`Invalid CDP frame: ${error.message}`));
        }
      }
      boundary = this.buffer.indexOf(0);
    }
  }

  dispatch(message) {
    if (message.id) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  rejectAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  command(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${commandTimeoutMs}ms`));
      }, commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.writer.write(`${JSON.stringify(message)}\0`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}

function makePreloadSource() {
  return String.raw`
    (() => {
      try { localStorage.clear(); } catch {}
      globalThis.__roomPilotSmoke = { fetches: [] };
      const originalFetch = typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null;
      globalThis.fetch = async (input, init = {}) => {
        const raw = typeof input === "string" ? input : String(input?.url || input);
        globalThis.__roomPilotSmoke.fetches.push({ url: raw, method: init.method || "GET" });
        if (!originalFetch) throw new Error("Unexpected fetch in browser smoke: " + raw);
        return originalFetch(input, init);
      };
    })();
  `;
}

function unwrapRemoteObject(remoteObject) {
  if (remoteObject?.subtype === "error") {
    throw new Error(remoteObject.description || "Runtime evaluation returned an error");
  }
  return remoteObject?.value;
}

async function run() {
  console.log("TAP version 13");
  if (!existsSync(chromePath)) {
    console.log(`1..0 # SKIP browser-smoke: Chrome not found at ${chromePath}`);
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "room-pilot-browser-smoke-"));
  const profileRoot = path.join(tempRoot, "chrome-profile");
  if (!existsSync(standalonePreviewPath)) {
    throw new Error("Standalone preview is missing. Run npm run preview:file first.");
  }

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-features=MediaRouter,OptimizationHints,Translate",
      "--disable-sync",
      "--no-default-browser-check",
      "--no-first-run",
      "--mute-audio",
      "--remote-debugging-pipe",
      `--user-data-dir=${profileRoot}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12_000);
  });

  const cdp = new PipeCdpClient(chrome);
  const runtimeErrors = [];
  const buildRequestErrors = [];
  const buildRequestTasks = new Set();
  let sessionId;
  let passed = 0;
  const results = [];

  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const response = await cdp.command(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`Runtime.evaluate failed: ${detail}`);
    }
    return unwrapRemoteObject(response.result);
  };

  const waitFor = async (predicateExpression, label, timeoutMs = 8_000) => {
    const started = Date.now();
    let lastValue;
    while (Date.now() - started < timeoutMs) {
      lastValue = await evaluate(predicateExpression);
      if (lastValue) return lastValue;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${label}; last value=${JSON.stringify(lastValue)}`);
  };

  const click = async (selector) => {
    const clicked = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.click();
      return true;
    })()`);
    assert.equal(clicked, true, `click target exists: ${selector}`);
  };

  const fulfillBuiltRequest = async (message) => {
    const { requestId, request } = message.params;
    try {
      const response = await builtWorker.fetch(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
        }),
      );
      const body = request.method === "HEAD"
        ? ""
        : Buffer.from(await response.arrayBuffer()).toString("base64");
      await cdp.command(
        "Fetch.fulfillRequest",
        {
          requestId,
          responseCode: response.status,
          responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
          body,
        },
        sessionId,
      );
    } catch (error) {
      buildRequestErrors.push(String(error.stack || error));
      await cdp.command("Fetch.failRequest", { requestId, errorReason: "Failed" }, sessionId).catch(() => {});
    }
  };

  const navigate = async (query = "", width = 390) => {
    runtimeErrors.length = 0;
    await cdp.command(
      "Emulation.setDeviceMetricsOverride",
      {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: width,
        screenHeight: 844,
      },
      sessionId,
    );
    const url = `${pathToFileURL(standalonePreviewPath).href}${query ? `?${query}` : ""}`;
    const navigation = await cdp.command("Page.navigate", { url }, sessionId);
    if (navigation.errorText) throw new Error(`Page.navigate: ${navigation.errorText}`);
    await waitFor("document.readyState !== 'loading'", "document readiness");
  };

  const navigateBuiltWorker = async (query = "role=employee", width = 390) => {
    runtimeErrors.length = 0;
    buildRequestErrors.length = 0;
    await cdp.command(
      "Emulation.setDeviceMetricsOverride",
      {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: width,
        screenHeight: 844,
      },
      sessionId,
    );
    const url = `https://room-pilot.test/${query ? `?${query}` : ""}`;
    const navigation = await cdp.command("Page.navigate", { url }, sessionId);
    if (navigation.errorText) throw new Error(`Page.navigate: ${navigation.errorText}`);
    await waitFor("document.readyState !== 'loading'", "built worker document readiness");
  };

  const waitForApp = async () => {
    await waitFor(
      "!document.querySelector('#app-shell')?.hidden && document.querySelectorAll('[data-tab]').length === 5 && !document.querySelector('#app-shell')?.classList.contains('is-bootstrapping')",
      "ROOM PILOT app bootstrap",
    );
    const hasBootstrapError = await evaluate("document.querySelector('#app-shell')?.classList.contains('has-bootstrap-error')");
    assert.equal(hasBootstrapError, false, "mock bootstrap succeeds");
  };

  const assertNoHorizontalOverflow = async (context) => {
    const metrics = await evaluate(`({
      innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
        })
        .slice(0, 8)
        .map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right }))
    })`);
    assert.ok(
      metrics.documentWidth <= metrics.innerWidth + 1 && metrics.bodyWidth <= metrics.innerWidth + 1,
      `${context}: no horizontal overflow (${JSON.stringify(metrics)})`,
    );
  };

  // 0件モードではカードが出ないので、何を待つかを呼び出し側で選ぶ
  const selectCustomer = async (customerId = "c1", expect = "card") => {
    await click('[data-tab="customers"]');
    await waitFor("document.querySelector('#customers-title')?.textContent === '顧客'", "customers tab");
    await click(`[data-action="open-customer"][data-id="${customerId}"]`);
    await waitFor("Boolean(document.querySelector('#customer-detail-title'))", "customer detail sheet");
    await click(`[data-action="select-customer"][data-id="${customerId}"]`);
    await waitFor(
      expect === "empty"
        ? "Boolean(document.querySelector('.empty-state'))"
        : "Boolean(document.querySelector('.top-card[data-property-card]'))",
      `${expect === "empty" ? "empty state" : "property card"} after customer selection`,
    );
  };

  const test = async (name, task) => {
    try {
      await task();
      passed += 1;
      results.push(`ok ${passed} - ${name}`);
    } catch (error) {
      results.push(`not ok ${passed + 1} - ${name}\n  ${String(error.stack || error).replaceAll("\n", "\n  ")}`);
      throw error;
    }
  };

  try {
    await cdp.command("Browser.getVersion");
    const { targetId } = await cdp.command("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await cdp.command("Target.attachToTarget", { targetId, flatten: true }));
    await cdp.command("Page.enable", {}, sessionId);
    await cdp.command("Runtime.enable", {}, sessionId);
    await cdp.command("Log.enable", {}, sessionId);
    await cdp.command(
      "Fetch.enable",
      { patterns: [{ urlPattern: "https://room-pilot.test/*", requestStage: "Request" }] },
      sessionId,
    );
    await cdp.command(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: makePreloadSource() },
      sessionId,
    );
    cdp.onEvent((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Fetch.requestPaused") {
        const task = fulfillBuiltRequest(message);
        buildRequestTasks.add(task);
        task.finally(() => buildRequestTasks.delete(task));
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
    });

    await test("通常配備WorkerのES ModulesとAPI接続で初期表示できる", async () => {
      await navigateBuiltWorker("role=employee", 390);
      await waitForApp();
      const state = await evaluate(`({
        protocol: location.protocol,
        host: location.host,
        hasModuleEntry: Boolean(document.querySelector('script[type="module"][src="/app.js"]')),
        bootstrapFetches: globalThis.__roomPilotSmoke.fetches.filter((item) => item.url.endsWith('/api/mock/bootstrap')).length,
        title: document.querySelector('.page-title, .empty-title')?.textContent.trim()
      })`);
      assert.equal(state.protocol, "https:");
      assert.equal(state.host, "room-pilot.test");
      assert.equal(state.hasModuleEntry, true);
      assert.equal(state.bootstrapFetches, 1);
      assert.match(state.title, /今日の操縦席/u);
      assert.deepEqual(runtimeErrors, [], `no runtime exceptions: ${runtimeErrors.join(" | ")}`);
      assert.deepEqual(buildRequestErrors, [], `no Worker request errors: ${buildRequestErrors.join(" | ")}`);
    });

    await test("360/390/430pxで5画面に横スクロールが発生しない", async () => {
      const expectedHeadings = {
        customers: "顧客",
        properties: "物件",
        today: "今日の操縦席",
        viewings: "内見",
        cases: "案件",
      };
      for (const width of [360, 390, 430]) {
        await navigate(`smoke=viewport-${width}`, width);
        await waitForApp();
        for (const [tab, heading] of Object.entries(expectedHeadings)) {
          await click(`[data-tab="${tab}"]`);
          await waitFor(
            `document.querySelector('[data-tab="${tab}"]')?.getAttribute('aria-current') === 'page'`,
            `${tab} selected`,
          );
          const title = await evaluate("document.querySelector('.page-title, .empty-title')?.textContent.trim()");
          assert.ok(title.includes(heading), `${tab} heading is visible at ${width}px (actual=${title})`);
          await assertNoHorizontalOverflow(`${width}px/${tab}`);
        }
      }
      assert.deepEqual(runtimeErrors, [], `no runtime exceptions: ${runtimeErrors.join(" | ")}`);
    });

    await test("未承認社員と顧客は営業画面へ入れない", async () => {
      await navigate("role=pending", 390);
      await waitFor("document.querySelector('#access-title')?.textContent.includes('社員申請を')", "pending access gate");
      let gate = await evaluate(`({
        shellHidden: document.querySelector('#app-shell').hidden,
        gateHidden: document.querySelector('#access-gate').hidden,
        text: document.querySelector('#access-gate').textContent
      })`);
      assert.equal(gate.shellHidden, true);
      assert.equal(gate.gateHidden, false);
      assert.match(gate.text, /承認待ち/);

      await navigate("role=customer", 390);
      await waitFor("document.querySelector('#access-title')?.textContent.includes('アクセスできません')", "customer access gate");
      gate = await evaluate(`({
        shellHidden: document.querySelector('#app-shell').hidden,
        gateHidden: document.querySelector('#access-gate').hidden,
        text: document.querySelector('#access-gate').textContent
      })`);
      assert.equal(gate.shellHidden, true);
      assert.equal(gate.gateHidden, false);
      assert.match(gate.text, /社員専用/);
      assert.equal(await evaluate("Boolean(document.querySelector('.property-card'))"), false);
      assert.equal(await evaluate("globalThis.__roomPilotSmoke.fetches.length"), 0, "権限拒否時は外部APIを呼ばない");
    });

    await test("顧客選択後にLike・Skip・Undoを保存／復元できる", async () => {
      await navigate("smoke=decisions", 390);
      await waitForApp();
      await selectCustomer("c1");
      await assertNoHorizontalOverflow("390px/property-card");

      const firstId = await evaluate("document.querySelector('.top-card').dataset.propertyId");
      await click('[data-action="property-like"]');
      await waitFor(
        `document.querySelector('.top-card')?.dataset.propertyId !== ${JSON.stringify(firstId)}`,
        "next property after Like",
      );
      let saved = await evaluate(`JSON.parse(localStorage.getItem('room-pilot:v2')).decisions.c1`);
      assert.ok(saved.liked.includes(firstId), "Like is saved for the selected customer");
      assert.match(await evaluate("document.querySelector('#toast-region').textContent"), /元に戻す/);

      await click('[data-action="undo-decision"]');
      await waitFor(
        `document.querySelector('.top-card')?.dataset.propertyId === ${JSON.stringify(firstId)}`,
        "same property restored by Undo",
      );
      saved = await evaluate(`JSON.parse(localStorage.getItem('room-pilot:v2')).decisions.c1`);
      assert.equal(saved.liked.includes(firstId), false, "Undo removes only the last Like");

      await click('[data-action="property-skip"]');
      await waitFor(
        `document.querySelector('.top-card')?.dataset.propertyId !== ${JSON.stringify(firstId)}`,
        "next property after Skip",
      );
      saved = await evaluate(`JSON.parse(localStorage.getItem('room-pilot:v2')).decisions.c1`);
      assert.ok(saved.skipped.includes(firstId), "Skip is saved for the selected customer");
      await click('[data-action="undo-decision"]');
      await waitFor(
        `document.querySelector('.top-card')?.dataset.propertyId === ${JSON.stringify(firstId)}`,
        "same property restored after Skip Undo",
      );
    });

    await test("表示設定の非表示と順番変更が画面へ反映される", async () => {
      await navigate("smoke=preference", 390);
      await waitForApp();
      await click('[data-action="edit-preference"][data-preference="widgets"]');
      await waitFor("Boolean(document.querySelector('#preference-form'))", "preference sheet");
      await click('[data-action="move-preference"][data-id="deadlines"][data-direction="-1"]');
      await waitFor(
        "document.querySelectorAll('.checkbox-card')[1]?.textContent.includes('期限')",
        "deadline widget moved to second",
      );
      await click('[data-action="move-preference"][data-id="deadlines"][data-direction="-1"]');
      await waitFor(
        "document.querySelector('[data-action=\"move-preference\"][data-id=\"deadlines\"][data-direction=\"-1\"]')?.disabled === true",
        "deadline widget moved first",
      );
      await evaluate(`(() => {
        const checkbox = document.querySelector('input[name="preference-item"][value="timeline"]');
        checkbox.click();
      })()`);
      await click('#preference-form button[type="submit"]');
      await waitFor("!document.querySelector('#preference-form')", "preference sheet closes");
      const setting = await evaluate(`({
        hasTimeline: Boolean(document.querySelector('#timeline-heading')),
        firstSection: document.querySelector('.view > .section')?.querySelector('.section-title')?.textContent,
        stored: JSON.parse(localStorage.getItem('room-pilot:v2')).displayPreference.widgets
      })`);
      assert.equal(setting.hasTimeline, false);
      assert.equal(setting.firstSection, "期限");
      assert.deepEqual(setting.stored, ["deadlines", "priority", "recommendation"]);
    });

    await test("stale・empty・errorのAPI状態を区別して表示する", async () => {
      await navigate("api=stale", 390);
      await waitForApp();
      await selectCustomer("c1");
      assert.match(await evaluate("document.querySelector('.freshness-warning')?.textContent || ''"), /情報が古い可能性/);

      await navigate("api=empty", 390);
      await waitForApp();
      await selectCustomer("c1", "empty");
      assert.match(await evaluate("document.querySelector('.empty-state')?.textContent || ''"), /条件に合う物件が0件/);

      await navigate("api=error", 390);
      await waitFor("Boolean(document.querySelector('#api-error-title'))", "API error state");
      assert.match(await evaluate("document.querySelector('#api-error-title').textContent"), /データを読み込めませんでした/);
      assert.match(await evaluate("document.querySelector('#app-view').textContent"), /入力内容は送信されていません/);
    });

    await test("返信案は営業が明示送信するまで送信済みにならない", async () => {
      await navigate("smoke=reply-safety", 390);
      await waitForApp();
      assert.equal(await evaluate("globalThis.__roomPilotSmoke.fetches.length"), 0, "単体プレビューは外部APIを呼ばない");
      await click('[data-action="open-reply"]');
      await waitFor("Boolean(document.querySelector('#reply-form'))", "reply draft sheet");
      let reply = await evaluate(`({
        text: document.querySelector('#modal-root').textContent,
        success: Boolean(document.querySelector('.success-safety')),
        externalFetches: globalThis.__roomPilotSmoke.fetches.length
      })`);
      assert.match(reply.text, /AIは自動送信しません/);
      assert.equal(reply.success, false);
      assert.equal(reply.externalFetches, 0);

      await click('#reply-form button[type="submit"]');
      await waitFor("document.querySelector('#recommend-heading + .recommend-card, .recommend-card')?.textContent.includes('返信済み')", "approved mock reply state");
      assert.match(await evaluate("document.querySelector('.recommend-card').textContent"), /石井さんへ返信済み/);
      // 送信後は優先アクション側の同じdata-actionが無効化される（未完了へ戻せない仕様）ので、
      // 記録を開く導線である推奨カードのボタンを指定する
      await click('.recommend-card [data-action="open-reply"]');
      await waitFor("Boolean(document.querySelector('.success-safety'))", "approved reply record");
      reply = await evaluate("document.querySelector('#modal-root').textContent");
      assert.match(reply, /営業が確認した本文だけ/);
    });

    console.log(`1..${passed}`);
    console.log(results.join("\n"));
    console.log(`browser-smoke: ${passed}/${passed} passed (Chrome CDP pipe, no local TCP server)`);
  } catch (error) {
    if (passed === 0 && cdp.exitInfo) {
      const { code, signal } = cdp.exitInfo;
      console.log(
        `1..0 # SKIP browser-smoke: Chrome could not start in this sandbox (code=${code}, signal=${signal}). ` +
          "Run the same file outside the managed sandbox, or set BROWSER_SMOKE_STRICT=1 to fail instead.",
      );
      if (process.env.BROWSER_SMOKE_STRICT !== "1") return;
    }
    console.log(`1..${Math.max(1, passed + 1)}`);
    console.log(results.join("\n"));
    if (stderr.trim()) console.error(`Chrome stderr (tail):\n${stderr.trim()}`);
    throw error;
  } finally {
    try {
      if (sessionId) await cdp.command("Browser.close", {}, undefined);
    } catch {}
    if (!chrome.killed) chrome.kill("SIGTERM");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await run();
