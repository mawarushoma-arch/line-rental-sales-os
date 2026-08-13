import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import { handleLineRequest, fingerprintReplyBody as workerFingerprint, threadIdFor } from "../worker/line-bridge.mjs";
import { fingerprintReplyBody as clientFingerprint } from "../public/api-adapter.mjs";

const SECRET = "test-channel-secret";
const TOKEN = "test-access-token";
const APP_KEY = "test-app-key";
const USER_ID = "U0123456789abcdef0123456789abcdef";

function createStore() {
  const entries = new Map();
  return {
    entries,
    async get(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    async put(key, value) {
      entries.set(key, String(value));
    },
    async delete(key) {
      entries.delete(key);
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...entries.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function createEnv(overrides = {}) {
  return {
    LINE_CHANNEL_SECRET: SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: TOKEN,
    ROOM_PILOT_LINE_KEY: APP_KEY,
    LINE_STORE: createStore(),
    ...overrides,
  };
}

function signedWebhook(bodyText, signature) {
  return new Request("https://example.com/line/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "x-line-signature": signature ?? sign(bodyText) }),
    },
    body: bodyText,
  });
}

function sign(bodyText) {
  return createHmac("sha256", SECRET).update(Buffer.from(bodyText, "utf8")).digest("base64");
}

function messageEvent(text, { eventId = "evt-1", replyToken = "reply-token-1", timestamp = 1_700_000_000_000 } = {}) {
  return {
    destination: "Uxxxx",
    events: [
      {
        type: "message",
        webhookEventId: eventId,
        timestamp,
        replyToken,
        source: { type: "user", userId: USER_ID },
        message: { type: "text", id: `${eventId}-msg`, text },
      },
    ],
  };
}

/** LINE APIを叩かずに通せるよう、fetchを差し替える */
function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function lineOk(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("本文指紋は画面側とサーバー側で一致する", () => {
  const samples = [
    "承知しました。内見の候補をお送りします。",
    "  前後の空白は無視される  ",
    "Multi\nline\nbody",
    "絵文字も同じ 🏠",
    "",
  ];
  for (const sample of samples) {
    assert.equal(workerFingerprint(sample), clientFingerprint(sample), `一致しない: ${sample}`);
  }
});

test("署名がないWebhookは本文を読まずに断る", async () => {
  const env = createEnv();
  const response = await handleLineRequest(signedWebhook(JSON.stringify(messageEvent("あ")), null), env);
  assert.equal(response.status, 401);
  assert.equal(env.LINE_STORE.entries.size, 0);
});

test("署名が違うWebhookは保存しない", async () => {
  const env = createEnv();
  const body = JSON.stringify(messageEvent("あ"));
  const response = await handleLineRequest(signedWebhook(body, "aW52YWxpZA=="), env);
  assert.equal(response.status, 401);
  assert.equal(env.LINE_STORE.entries.size, 0);
});

test("チャネルシークレット未設定なら受信を断る", async () => {
  const env = createEnv({ LINE_CHANNEL_SECRET: "" });
  const response = await handleLineRequest(signedWebhook(JSON.stringify(messageEvent("あ"))), env);
  assert.equal(response.status, 503);
});

test("署名が正しいWebhookは保存し、同じwebhookEventIdは二重に保存しない", async () => {
  const env = createEnv();
  const body = JSON.stringify(messageEvent("内見できますか？"));

  await withStubbedFetch(
    () => lineOk({ displayName: "テスト太郎", pictureUrl: "https://example.com/p.png" }),
    async () => {
      const first = await handleLineRequest(signedWebhook(body), env);
      assert.equal(first.status, 200);
      const second = await handleLineRequest(signedWebhook(body), env);
      assert.equal(second.status, 200);
    },
  );

  const messageKeys = [...env.LINE_STORE.entries.keys()].filter((key) => key.startsWith("msg:"));
  assert.equal(messageKeys.length, 1);
  assert.equal(JSON.parse(env.LINE_STORE.entries.get(messageKeys[0])).body, "内見できますか？");
});

test("保存に失敗した回は既読にせず、LINEの再送で埋め直せる", async () => {
  const env = createEnv();
  const store = env.LINE_STORE;
  const originalPut = store.put.bind(store);
  let failThreadWrite = true;
  store.put = async (key, value, options) => {
    if (failThreadWrite && key.startsWith("thread:")) throw new Error("KV write failed");
    return originalPut(key, value, options);
  };

  const body = JSON.stringify(messageEvent("内見をお願いします"));
  await withStubbedFetch(
    () => lineOk({ displayName: "テスト太郎" }),
    async () => {
      const first = await handleLineRequest(signedWebhook(body), env);
      assert.equal(first.status, 200, "LINEには200を返す");
    },
  );

  assert.ok(
    ![...store.entries.keys()].some((key) => key.startsWith("dedupe:")),
    "失敗した回に既読の印を付けてはいけない",
  );

  failThreadWrite = false;
  await withStubbedFetch(
    () => lineOk({ displayName: "テスト太郎" }),
    async () => {
      await handleLineRequest(signedWebhook(body), env);
    },
  );

  const threadsResponse = await handleLineRequest(
    new Request("https://example.com/api/line/threads", { headers: { "x-room-pilot-key": APP_KEY } }),
    env,
  );
  const { threads } = await threadsResponse.json();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].lastBody, "内見をお願いします");
  assert.ok([...store.entries.keys()].some((key) => key.startsWith("dedupe:")), "成功した回は既読にする");
});

test("スレッド情報が欠けても、受信済みメッセージを一覧から隠さない", async () => {
  const env = createEnv();
  await withStubbedFetch(
    () => lineOk({ displayName: "テスト太郎" }),
    async () => {
      await handleLineRequest(signedWebhook(JSON.stringify(messageEvent("よろしくお願いします"))), env);
    },
  );

  // スレッド情報だけを失った状態を作る
  for (const key of [...env.LINE_STORE.entries.keys()]) {
    if (key.startsWith("thread:")) env.LINE_STORE.entries.delete(key);
  }

  const response = await handleLineRequest(
    new Request("https://example.com/api/line/threads", { headers: { "x-room-pilot-key": APP_KEY } }),
    env,
  );
  const { threads } = await response.json();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].lastBody, "よろしくお願いします");
});

test("画面向けAPIは合言葉がないと開けない", async () => {
  const env = createEnv();
  const response = await handleLineRequest(new Request("https://example.com/api/line/threads"), env);
  assert.equal(response.status, 401);
});

test("スレッドとメッセージに生のuser IDとreplyTokenを含めない", async () => {
  const env = createEnv();
  await withStubbedFetch(
    () => lineOk({ displayName: "テスト太郎" }),
    async () => {
      await handleLineRequest(signedWebhook(JSON.stringify(messageEvent("こんにちは"))), env);
    },
  );

  const threadsResponse = await handleLineRequest(
    new Request("https://example.com/api/line/threads", { headers: { "x-room-pilot-key": APP_KEY } }),
    env,
  );
  const threadsText = await threadsResponse.text();
  assert.equal(threadsResponse.status, 200);
  assert.ok(!threadsText.includes(USER_ID), "生のuser IDが漏れている");
  assert.ok(!threadsText.includes("reply-token-1"), "replyTokenが漏れている");

  const threadId = JSON.parse(threadsText).threads[0].threadId;
  assert.equal(threadId, await threadIdFor(SECRET, USER_ID));

  const messagesResponse = await handleLineRequest(
    new Request(`https://example.com/api/line/messages?thread=${threadId}`, {
      headers: { "x-room-pilot-key": APP_KEY },
    }),
    env,
  );
  const messagesText = await messagesResponse.text();
  assert.ok(!messagesText.includes(USER_ID));
  assert.ok(!messagesText.includes("reply-token-1"));
  assert.equal(JSON.parse(messagesText).messages[0].body, "こんにちは");
});

async function seedThread(env, { replyToken = "reply-token-1", timestamp = Date.now() } = {}) {
  await withStubbedFetch(
    () => lineOk({ displayName: "テスト太郎" }),
    async () => {
      await handleLineRequest(signedWebhook(JSON.stringify(messageEvent("よろしくお願いします", { replyToken, timestamp }))), env);
    },
  );
  return threadIdFor(SECRET, USER_ID);
}

function sendRequest(payload) {
  return new Request("https://example.com/api/line/send", {
    method: "POST",
    headers: { "x-room-pilot-key": APP_KEY, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function approvedPayload(threadId, body, overrides = {}) {
  return {
    threadId,
    body,
    draftId: "live-draft-1",
    idempotencyKey: "live-draft-1",
    confirmed: true,
    bodyFingerprint: workerFingerprint(body),
    approvedBy: "employee:sato",
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("承認記録がない送信は断る", async () => {
  const env = createEnv();
  const threadId = await seedThread(env);
  const response = await handleLineRequest(
    sendRequest(approvedPayload(threadId, "送ります", { confirmed: false })),
    env,
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "UNAPPROVED_REPLY");
});

test("承認後に本文が差し替わった送信は断る", async () => {
  const env = createEnv();
  const threadId = await seedThread(env);
  const payload = approvedPayload(threadId, "確認した本文");
  payload.body = "すり替えた本文";
  const response = await handleLineRequest(sendRequest(payload), env);
  assert.equal(response.status, 409);
});

test("承認から時間が経った送信は断る", async () => {
  const env = createEnv();
  const threadId = await seedThread(env);
  const response = await handleLineRequest(
    sendRequest(
      approvedPayload(threadId, "送ります", {
        approvedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }),
    ),
    env,
  );
  assert.equal(response.status, 409);
});

test("受信直後は応答メッセージを使い、同じ内容の再送は1通しか送らない", async () => {
  const env = createEnv();
  const threadId = await seedThread(env);

  await withStubbedFetch(
    (url) => {
      if (url.endsWith("/v2/bot/message/reply")) return lineOk({ sentMessages: [{ id: "m-1" }] });
      return lineOk({});
    },
    async (calls) => {
      const first = await handleLineRequest(sendRequest(approvedPayload(threadId, "承知しました")), env);
      assert.equal(first.status, 200);
      assert.equal((await first.json()).method, "reply");

      const second = await handleLineRequest(sendRequest(approvedPayload(threadId, "承知しました")), env);
      assert.equal((await second.json()).duplicate, true);

      const sendCalls = calls.filter((call) => call.url.includes("/v2/bot/message/"));
      assert.equal(sendCalls.length, 1, "LINEへの送信が2回起きている");
    },
  );
});

test("応答トークンが切れていればプッシュ送信へ回す", async () => {
  const env = createEnv();
  const threadId = await seedThread(env, { replyToken: "" });

  await withStubbedFetch(
    (url) => {
      if (url.endsWith("/v2/bot/message/push")) return lineOk({ sentMessages: [{ id: "m-2" }] });
      return lineOk({});
    },
    async (calls) => {
      const response = await handleLineRequest(sendRequest(approvedPayload(threadId, "改めてご連絡します")), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).method, "push");
      const push = calls.find((call) => call.url.endsWith("/v2/bot/message/push"));
      assert.ok(push, "push APIが呼ばれていない");
      assert.ok(push.options.headers["x-line-retry-key"], "再送キーが付いていない");
    },
  );
});

test("送信失敗は成功にせず、failed として残す", async () => {
  const env = createEnv();
  const threadId = await seedThread(env, { replyToken: "" });

  await withStubbedFetch(
    () =>
      new Response(JSON.stringify({ message: "You have reached your monthly limit." }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const response = await handleLineRequest(sendRequest(approvedPayload(threadId, "送れないはず")), env);
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.error, "SEND_FAILED");
      assert.equal(payload.record.status, "failed");
    },
  );

  const stored = [...env.LINE_STORE.entries.entries()]
    .filter(([key]) => key.startsWith("msg:"))
    .map(([, value]) => JSON.parse(value));
  assert.ok(stored.some((record) => record.direction === "out" && record.status === "failed"));
  assert.ok(!stored.some((record) => record.direction === "out" && record.status === "sent"));
});
