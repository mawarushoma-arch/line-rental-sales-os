/**
 * 公式LINE（Messaging API）との唯一の境界。
 *
 * docs/architecture.md 3-2 の約束を、モックではなくサーバー側で強制する。
 *  - Webhookは X-Line-Signature を検証してから本文を読む。検証前に中身を信用しない
 *  - LINEの再送に備え webhookEventId で冪等化する
 *  - 送信は「営業の承認記録」と「本文指紋の一致」が揃ったときだけ Messaging API を呼ぶ
 *  - 生のLINE user ID と replyToken はサーバー限定。画面へ返すのは不可逆な threadId だけ
 *  - 送信失敗は成功へ丸めず failed として残す。再送は営業の明示操作に限る
 *
 * 保存はKV（binding: LINE_STORE）。キー設計は以下。
 *  alias:{threadId}            -> { userId }                     threadId から生IDを引く
 *  thread:{threadId}           -> スレッド情報（replyToken を含むため、そのまま返さない）
 *  msg:{threadId}:{ts14}:{id}  -> メッセージ1件。キーが時刻順に並ぶので list だけで整列できる
 *  dedupe:{webhookEventId}     -> 受信済みの印
 *  retry:{idempotencyKey}      -> Push再送用の X-Line-Retry-Key
 *  sent:{idempotencyKey}       -> 送信済みの結果。二重送信を止める
 */

const LINE_API = "https://api.line.me";
const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 3;
const SENT_TTL_SECONDS = 60 * 60 * 24;
const MESSAGE_TTL_SECONDS = 60 * 60 * 24 * 60;
/** Reply APIのトークンは受信直後しか使えない。過ぎたものはPushへ回す */
const REPLY_WINDOW_MS = 50_000;
/** 承認から時間が経った本文は送らせない */
const APPROVAL_MAX_AGE_MS = 10 * 60 * 1000;
/** LINEのテキスト上限5000に対する安全側 */
const MAX_BODY_LENGTH = 4_800;
const MESSAGE_PAGE_SIZE = 200;

const encoder = new TextEncoder();

/**
 * public/api-adapter.mjs の fingerprintReplyBody と同じFNV-1a。
 * 画面が作った指紋をサーバーで作り直して突き合わせるため、両方に実装がある。
 * ずれると承認済みの本文が送れなくなるので tests/line-bridge.test.mjs で一致を固定している。
 */
export function fingerprintReplyBody(body) {
  const value = String(body || "").trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function toBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

/** 長さの違いも含めて、比較時間から中身が漏れないようにする */
function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length, 1);
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/**
 * 生のLINE user IDを画面へ出さないための不可逆なID。
 * チャネルシークレットを鍵にするので、同じ利用者なら常に同じ値になる。
 */
export async function threadIdFor(secret, userId) {
  const digest = await hmacSha256(secret, encoder.encode(`thread:${userId}`));
  return `t_${toBase64Url(digest).slice(0, 22)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function messageKey(threadId, timestampMs, id) {
  const stamp = String(timestampMs).padStart(14, "0");
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "x";
  return `msg:${threadId}:${stamp}:${safeId}`;
}

async function readJson(store, key) {
  const raw = await store.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function upsertThread(store, threadId, patch) {
  const current = (await readJson(store, `thread:${threadId}`)) || {
    threadId,
    createdAt: nowIso(),
  };
  const next = { ...current, ...patch, threadId };
  await store.put(`thread:${threadId}`, JSON.stringify(next));
  return next;
}

/** replyToken と生IDを落とした、画面へ渡してよい形 */
function publicThread(thread) {
  const replyTokenAt = Number(thread.replyTokenAt) || 0;
  return {
    threadId: thread.threadId,
    displayName: thread.displayName || "LINEの友だち",
    pictureUrl: thread.pictureUrl || "",
    lastAt: thread.lastAt || thread.createdAt || "",
    lastBody: thread.lastBody || "",
    lastDirection: thread.lastDirection || "",
    inboundCount: Number(thread.inboundCount) || 0,
    blocked: Boolean(thread.blocked),
    // 無料の応答メッセージで返せる残り時間があるか。トークン自体は渡さない
    replyWindowMsLeft: Boolean(thread.replyToken)
      ? Math.max(0, REPLY_WINDOW_MS - (Date.now() - replyTokenAt))
      : 0,
  };
}

const MESSAGE_KIND_LABEL = {
  image: "［画像を受信しました］",
  video: "［動画を受信しました］",
  audio: "［音声を受信しました］",
  file: "［ファイルを受信しました］",
  location: "［位置情報を受信しました］",
  sticker: "［スタンプを受信しました］",
};

async function fetchProfile(env, userId) {
  try {
    const response = await fetch(`${LINE_API}/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function callLine(env, path, payload, extraHeaders = {}) {
  const response = await fetch(`${LINE_API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  let detail = null;
  try {
    detail = await response.json();
  } catch {
    detail = null;
  }
  return { ok: response.ok, status: response.status, detail };
}

/* ------------------------------------------------------------------ 受信 */

async function storeInboundEvent(store, env, secret, event) {
  const userId = event.source?.userId;
  if (!userId) return;

  const threadId = await threadIdFor(secret, userId);
  await store.put(`alias:${threadId}`, JSON.stringify({ userId }));

  const existing = (await readJson(store, `thread:${threadId}`)) || { threadId, createdAt: nowIso() };
  const patch = {};

  if (event.type === "follow") {
    patch.blocked = false;
    patch.followedAt = nowIso();
  }
  if (event.type === "unfollow") {
    patch.blocked = true;
    await upsertThread(store, threadId, { ...patch, replyToken: "", replyTokenAt: 0 });
    return;
  }

  // 応答メッセージ用のトークンは保存するが、画面へは絶対に返さない
  if (event.replyToken) {
    patch.replyToken = event.replyToken;
    patch.replyTokenAt = Date.now();
  }

  if (event.type !== "message") {
    await upsertThread(store, threadId, patch);
    return;
  }

  const kind = event.message?.type || "text";
  const body =
    kind === "text"
      ? String(event.message.text || "")
      : MESSAGE_KIND_LABEL[kind] || `［${kind}を受信しました］`;
  const timestamp = Number(event.timestamp) || Date.now();
  const at = new Date(timestamp).toISOString();
  const lineMessageId = String(event.message?.id || event.webhookEventId || timestamp);

  const record = {
    id: `in-${lineMessageId}`,
    threadId,
    direction: "in",
    body,
    at,
    status: "received",
    kind,
    lineMessageId,
  };
  await store.put(messageKey(threadId, timestamp, lineMessageId), JSON.stringify(record), {
    expirationTtl: MESSAGE_TTL_SECONDS,
  });

  await upsertThread(store, threadId, {
    ...patch,
    lastAt: at,
    lastBody: body,
    lastDirection: "in",
    inboundCount: (Number(existing.inboundCount) || 0) + 1,
  });
}

async function handleWebhook(request, env) {
  const secret = env.LINE_CHANNEL_SECRET;
  const store = env.LINE_STORE;
  if (!secret || !store) {
    return json({ error: "NOT_CONFIGURED", message: "チャネルシークレットまたは保存先が未設定です" }, 503);
  }

  const signature = request.headers.get("x-line-signature");
  if (!signature) return json({ error: "NO_SIGNATURE" }, 401);

  // 署名の対象は生のバイト列。検証前に本文をJSONとして扱わない
  const raw = new Uint8Array(await request.arrayBuffer());
  const expected = toBase64(await hmacSha256(secret, raw));
  if (!safeEqual(signature, expected)) return json({ error: "BAD_SIGNATURE" }, 401);

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "BAD_BODY" }, 400);
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    const eventId = event.webhookEventId;
    if (eventId && (await store.get(`dedupe:${eventId}`))) continue;
    try {
      await storeInboundEvent(store, env, secret, event);
      // 印を付けるのは保存し終えてから。先に付けると、途中で落ちた回を再送で埋め直せない
      if (eventId) await store.put(`dedupe:${eventId}`, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
    } catch (error) {
      // 1件の失敗で残りを落とさない。LINEには200を返し、再送で埋める。
      // 握りつぶすと原因が追えなくなるので、本文は伏せて理由だけ残す
      console.error("storeInboundEvent failed", event.type, String(error?.stack || error));
      try {
        await store.put(
          `error:${Date.now()}`,
          JSON.stringify({ at: nowIso(), eventType: event.type, detail: String(error?.stack || error) }),
          { expirationTtl: 60 * 60 * 24 },
        );
      } catch {
        // 記録にも失敗したら諦める
      }
    }
  }

  return json({ ok: true, received: events.length });
}

/* ------------------------------------------------------------------ 画面向けAPI */

function requireKey(request, env) {
  const configured = env.ROOM_PILOT_LINE_KEY;
  if (!configured) {
    return json({ error: "NOT_CONFIGURED", message: "合言葉が未設定のため開けません" }, 503);
  }
  const provided = request.headers.get("x-room-pilot-key") || "";
  if (!safeEqual(provided, configured)) {
    return json({ error: "UNAUTHORIZED", message: "合言葉が違います" }, 401);
  }
  return null;
}

async function handleStatus(env) {
  const configured = Boolean(env.LINE_CHANNEL_ACCESS_TOKEN);
  const result = {
    ready: configured && Boolean(env.LINE_CHANNEL_SECRET) && Boolean(env.LINE_STORE),
    secretConfigured: Boolean(env.LINE_CHANNEL_SECRET),
    storeConfigured: Boolean(env.LINE_STORE),
    bot: null,
    quota: null,
    webhookEndpoint: null,
  };
  if (!configured) return json(result);

  const headers = { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const [info, quota, consumption, endpoint] = await Promise.all([
    fetch(`${LINE_API}/v2/bot/info`, { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`${LINE_API}/v2/bot/message/quota`, { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`${LINE_API}/v2/bot/message/quota/consumption`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${LINE_API}/v2/bot/channel/webhook/endpoint`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  if (info) {
    result.bot = {
      displayName: info.displayName || "",
      basicId: info.basicId || "",
      pictureUrl: info.pictureUrl || "",
      chatMode: info.chatMode || "",
    };
  }
  if (quota) {
    result.quota = {
      type: quota.type || "",
      limit: Number.isFinite(quota.value) ? quota.value : null,
      used: Number(consumption?.totalUsage) || 0,
    };
  }
  if (endpoint) {
    result.webhookEndpoint = { endpoint: endpoint.endpoint || "", active: Boolean(endpoint.active) };
  }
  return json(result);
}

/**
 * スレッド情報が無い相手を、受信済みメッセージから組み立て直す。
 * 保存が途中で落ちても、届いた会話を画面から隠さないための保険。
 */
async function recoverThread(store, threadId) {
  const listing = await store.list({ prefix: `msg:${threadId}:`, limit: 1000 });
  if (!listing.keys.length) return null;
  const newest = await readJson(store, listing.keys[listing.keys.length - 1].name);
  return {
    threadId,
    displayName: "",
    lastAt: newest?.at || "",
    lastBody: newest?.body || "",
    lastDirection: newest?.direction || "in",
    inboundCount: listing.keys.length,
    recovered: true,
  };
}

async function handleThreads(env) {
  const store = env.LINE_STORE;
  const [threadListing, aliasListing] = await Promise.all([
    store.list({ prefix: "thread:", limit: 1000 }),
    store.list({ prefix: "alias:", limit: 1000 }),
  ]);

  const byId = new Map();
  for (const key of threadListing.keys) {
    const thread = await readJson(store, key.name);
    if (thread?.threadId) byId.set(thread.threadId, thread);
  }
  for (const key of aliasListing.keys) {
    const threadId = key.name.slice("alias:".length);
    if (byId.has(threadId)) continue;
    const recovered = await recoverThread(store, threadId);
    if (recovered) byId.set(threadId, recovered);
  }

  // 表示名はここで補う。Webhookは保存だけに専念させ、外部APIへは行かせない
  await fillMissingNames(store, env, [...byId.values()]);

  const threads = [...byId.values()].map(publicThread);
  threads.sort((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)));
  return json({ threads });
}

/** 表示名が未取得の相手だけ、一覧を開いたときにLINEへ聞きに行く */
async function fillMissingNames(store, env, threads, limit = 5) {
  const targets = threads.filter((thread) => !thread.displayName).slice(0, limit);
  for (const thread of targets) {
    const alias = await readJson(store, `alias:${thread.threadId}`);
    if (!alias?.userId) continue;
    const profile = await fetchProfile(env, alias.userId);
    if (!profile?.displayName) continue;
    thread.displayName = profile.displayName;
    thread.pictureUrl = profile.pictureUrl || "";
    try {
      // 組み立て直した相手はまだ保存されていないので、丸ごと書き戻す
      const { recovered, ...record } = thread;
      await upsertThread(store, thread.threadId, record);
    } catch {
      // 保存できなくても、今回の表示には使える
    }
  }
}

async function handleMessages(request, env) {
  const store = env.LINE_STORE;
  const url = new URL(request.url);
  const threadId = url.searchParams.get("thread") || "";
  if (!/^t_[A-Za-z0-9_-]{1,40}$/.test(threadId)) {
    return json({ error: "INVALID_THREAD", message: "スレッドの指定が不正です" }, 400);
  }
  const since = url.searchParams.get("since") || "";

  const listing = await store.list({ prefix: `msg:${threadId}:`, limit: 1000 });
  let names = listing.keys.map((key) => key.name).sort();
  if (since) names = names.filter((name) => name > since);
  const page = names.slice(-MESSAGE_PAGE_SIZE);

  const messages = [];
  for (const name of page) {
    const record = await readJson(store, name);
    if (record) messages.push(record);
  }

  const thread = await readJson(store, `thread:${threadId}`);
  return json({
    messages,
    cursor: names.length ? names[names.length - 1] : since,
    thread: thread ? publicThread(thread) : null,
    analysis: since ? undefined : await readJson(store, `analysis:${threadId}`),
  });
}

/**
 * 承認済みの本文だけをLINEへ渡す。
 * 画面から来た指紋をサーバーで作り直して突き合わせるので、承認後に本文が差し替わると弾かれる。
 */
async function handleSend(request, env) {
  const store = env.LINE_STORE;
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "BAD_BODY", message: "本文を読み取れません" }, 400);
  }

  const threadId = String(payload.threadId || "");
  const body = String(payload.body || "").trim();
  const draftId = String(payload.draftId || "").trim();
  const approvedBy = String(payload.approvedBy || "").trim();
  const approvedAt = String(payload.approvedAt || "").trim();

  if (!/^t_[A-Za-z0-9_-]{1,40}$/.test(threadId)) {
    return json({ error: "INVALID_THREAD", message: "スレッドの指定が不正です" }, 400);
  }
  if (!body) return json({ error: "INVALID_REPLY", message: "本文が空です" }, 400);
  if (body.length > MAX_BODY_LENGTH) {
    return json({ error: "INVALID_REPLY", message: `本文は${MAX_BODY_LENGTH}文字までです` }, 400);
  }

  // ここから下が「承認記録と本文指紋が揃ったときだけ送る」の実体
  if (payload.confirmed !== true || !draftId || !approvedBy || !approvedAt) {
    return json({ error: "UNAPPROVED_REPLY", message: "営業の確認記録がありません" }, 409);
  }
  if (payload.bodyFingerprint !== fingerprintReplyBody(body)) {
    return json({ error: "UNAPPROVED_REPLY", message: "確認したときの本文と一致しません" }, 409);
  }
  const approvedAtMs = Date.parse(approvedAt);
  if (!Number.isFinite(approvedAtMs) || Date.now() - approvedAtMs > APPROVAL_MAX_AGE_MS || approvedAtMs - Date.now() > 60_000) {
    return json({ error: "UNAPPROVED_REPLY", message: "確認から時間が経ちました。もう一度確認してください" }, 409);
  }

  const idempotencyKey =
    String(payload.idempotencyKey || "").replace(/[^A-Za-z0-9_:-]/g, "").slice(0, 80) ||
    `${threadId}:${payload.bodyFingerprint}:${approvedAtMs}`;

  const alreadySent = await readJson(store, `sent:${idempotencyKey}`);
  if (alreadySent) return json({ ...alreadySent, duplicate: true });

  const alias = await readJson(store, `alias:${threadId}`);
  if (!alias?.userId) {
    return json({ error: "UNKNOWN_THREAD", message: "この相手の情報がありません" }, 404);
  }

  const thread = (await readJson(store, `thread:${threadId}`)) || { threadId };
  if (thread.blocked) {
    return json({ error: "BLOCKED", message: "この方はブロック中のため送信できません" }, 409);
  }

  const messages = [{ type: "text", text: body }];
  const canReply =
    Boolean(thread.replyToken) && Date.now() - (Number(thread.replyTokenAt) || 0) < REPLY_WINDOW_MS;

  let method = canReply ? "reply" : "push";
  let result;

  if (canReply) {
    result = await callLine(env, "/v2/bot/message/reply", { replyToken: thread.replyToken, messages });
    // 応答トークンは1回きり。成否にかかわらず使い切りにする
    await upsertThread(store, threadId, { replyToken: "", replyTokenAt: 0 });
    // トークンが無効だった場合だけPushへ回す。500系は二重送信になり得るので回さない
    if (!result.ok && result.status === 400) {
      method = "push";
      result = null;
    }
  }

  if (method === "push" && !result) {
    // 再送しても1通しか届かないよう、同じ再送キーを使い回す
    let retryKey = await store.get(`retry:${idempotencyKey}`);
    if (!retryKey) {
      retryKey = crypto.randomUUID();
      await store.put(`retry:${idempotencyKey}`, retryKey, { expirationTtl: SENT_TTL_SECONDS });
    }
    result = await callLine(
      env,
      "/v2/bot/message/push",
      { to: alias.userId, messages },
      { "x-line-retry-key": retryKey },
    );
  }

  const sentAtMs = Date.now();
  const at = new Date(sentAtMs).toISOString();
  const lineMessageId = String(result?.detail?.sentMessages?.[0]?.id || `local-${sentAtMs}`);
  const record = {
    id: `out-${lineMessageId}`,
    threadId,
    direction: "out",
    body,
    at,
    status: result?.ok ? "sent" : "failed",
    kind: "text",
    method,
    lineMessageId: result?.ok ? lineMessageId : "",
    draftId,
    approvedBy,
    approvedAt,
    bodyFingerprint: payload.bodyFingerprint,
  };
  await store.put(messageKey(threadId, sentAtMs, lineMessageId), JSON.stringify(record), {
    expirationTtl: MESSAGE_TTL_SECONDS,
  });

  if (!result?.ok) {
    // 失敗を成功へ丸めない。再送は営業がもう一度確認したときだけ
    const detail = result?.detail?.message || `LINEが${result?.status || 0}を返しました`;
    return json({ error: "SEND_FAILED", message: detail, method, record }, 502);
  }

  await upsertThread(store, threadId, {
    lastAt: at,
    lastBody: body,
    lastDirection: "out",
  });

  const success = { ok: true, method, record };
  await store.put(`sent:${idempotencyKey}`, JSON.stringify(success), { expirationTtl: SENT_TTL_SECONDS });
  return json(success);
}

/* ------------------------------------------------------------------ AIによる整理 */

const ANALYSIS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const ANALYSIS_MAX_MESSAGES = 40;
const ANALYSIS_MAX_CHARS = 6_000;

/** 画面に出す順。SearchConditionのlabelと揃えている */
const ANALYSIS_FIELDS = [
  ["area", "希望エリア"],
  ["budget", "賃料上限"],
  ["layout", "間取り"],
  ["moveIn", "入居希望日"],
  ["mustHave", "譲れない条件"],
  ["concern", "懸念・注意点"],
];

/**
 * 構造化出力の型。null を許すと実装差で弾かれることがあるので、
 * 読み取れない場合は空文字で返させ、こちら側で未確認として扱う。
 */
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    conditions: {
      type: "object",
      properties: Object.fromEntries(
        ANALYSIS_FIELDS.map(([key]) => [
          key,
          {
            type: "object",
            properties: { value: { type: "string" }, quote: { type: "string" } },
            required: ["value", "quote"],
          },
        ]),
      ),
      required: ANALYSIS_FIELDS.map(([key]) => key),
    },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "conditions", "questions"],
};

const ANALYSIS_SYSTEM = [
  "あなたは日本の賃貸仲介営業を補助するアシスタントです。",
  "顧客とのLINE会話から、営業が状況を把握するための要約と、希望条件の整理を作ります。",
  "",
  "厳守すること:",
  "- 会話に書かれていないことを推測で補わない。読み取れない項目は value と quote を空文字にする。",
  "- 各項目には、根拠になった顧客の発言を quote にそのまま入れる。言い換えたり要約したりしない。",
  "- 営業側の発言は根拠にしない。顧客の発言だけを根拠にする。",
  "- 金額や日付を勝手に丸めたり、範囲を広げたりしない。",
  "- 出力はJSONのみ。前置きも説明も付けない。",
].join("\n");

function buildTranscript(messages) {
  const recent = messages.slice(-ANALYSIS_MAX_MESSAGES);
  const lines = recent.map(
    (message) => `${message.direction === "in" ? "顧客" : "営業"}: ${String(message.body || "").slice(0, 500)}`,
  );
  let transcript = lines.join("\n");
  if (transcript.length > ANALYSIS_MAX_CHARS) transcript = transcript.slice(-ANALYSIS_MAX_CHARS);
  return { transcript, used: recent.length };
}

/** モデルが前後に文章を付けても拾えるようにする */
function parseJsonLoosely(text) {
  const raw = String(text || "");
  try {
    return JSON.parse(raw);
  } catch {
    // 続けて括弧の範囲を探す
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanText(value, limit = 400) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * AIが埋めた条件を、画面が扱う形（label / value / status）へ落とす。
 * 根拠の引用が無いものは推定として扱わず、未確認のままにする。
 */
function toConditionItems(parsed) {
  const source = parsed?.conditions && typeof parsed.conditions === "object" ? parsed.conditions : {};
  return ANALYSIS_FIELDS.map(([key, label]) => {
    const entry = source[key];
    const value = cleanText(entry?.value, 120);
    const quote = cleanText(entry?.quote, 200);
    if (!value || value === "null" || !quote) {
      return { label, value: "まだ確認できていません", status: "unknown", quote: "" };
    }
    return { label, value, status: "inferred", quote };
  });
}

async function handleAnalyze(request, env) {
  const store = env.LINE_STORE;
  if (!env.AI || typeof env.AI.run !== "function") {
    return json({ error: "NOT_CONFIGURED", message: "AIが接続されていません" }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "BAD_BODY", message: "本文を読み取れません" }, 400);
  }

  const threadId = String(payload.threadId || "");
  if (!/^t_[A-Za-z0-9_-]{1,40}$/.test(threadId)) {
    return json({ error: "INVALID_THREAD", message: "スレッドの指定が不正です" }, 400);
  }

  const listing = await store.list({ prefix: `msg:${threadId}:`, limit: 1000 });
  const messages = [];
  for (const key of listing.keys.map((entry) => entry.name).sort()) {
    const record = await readJson(store, key);
    if (record) messages.push(record);
  }
  const inbound = messages.filter((message) => message.direction === "in");
  if (!inbound.length) {
    return json({ error: "NO_MESSAGES", message: "顧客からのメッセージがまだありません" }, 409);
  }

  const { transcript, used } = buildTranscript(messages);
  let raw;
  try {
    const result = await env.AI.run(ANALYSIS_MODEL, {
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM },
        {
          role: "user",
          content: [
            "次のLINE会話を整理してください。",
            "",
            "```",
            transcript,
            "```",
            "",
            "次の形のJSONだけを返してください。読み取れない項目は value と quote を空文字にします。",
            JSON.stringify({
              summary: "営業が状況を把握できる3文以内の日本語",
              conditions: Object.fromEntries(
                ANALYSIS_FIELDS.map(([key, label]) => [key, { value: `${label}（読み取れなければ空文字）`, quote: "根拠になった顧客の発言" }]),
              ),
              questions: ["未確認を埋めるために次に聞くとよい質問（最大3つ）"],
            }),
          ].join("\n"),
        },
      ],
      max_tokens: 900,
      temperature: 0.1,
      response_format: { type: "json_schema", json_schema: ANALYSIS_SCHEMA },
    });
    // 構造化出力を指定するとオブジェクトで返り、指定が効かないときは文字列で返る
    raw = typeof result === "string" ? result : result?.response;
  } catch (error) {
    console.error("AI.run failed", String(error?.stack || error));
    return json({ error: "AI_FAILED", message: "AIの呼び出しに失敗しました" }, 502);
  }

  const parsed = raw && typeof raw === "object" ? raw : parseJsonLoosely(raw);
  if (!parsed) {
    return json(
      {
        error: "AI_FORMAT",
        message: "AIの返答を読み取れませんでした。もう一度お試しください",
        detail: cleanText(typeof raw === "string" ? raw : JSON.stringify(raw), 300),
      },
      502,
    );
  }

  const analysis = {
    threadId,
    summary: cleanText(parsed.summary, 400),
    items: toConditionItems(parsed),
    questions: Array.isArray(parsed.questions)
      ? parsed.questions.map((question) => cleanText(question, 120)).filter(Boolean).slice(0, 3)
      : [],
    messageCount: used,
    model: ANALYSIS_MODEL,
    at: nowIso(),
  };

  try {
    await store.put(`analysis:${threadId}`, JSON.stringify(analysis), { expirationTtl: MESSAGE_TTL_SECONDS });
  } catch {
    // 保存できなくても、今回の結果は返す
  }
  return json({ ok: true, analysis });
}

/* ------------------------------------------------------------------ ルーター */

/** LINE関連のパスだけを引き受ける。担当外は null を返して既存の配信へ渡す */
export async function handleLineRequest(request, env) {
  const pathname = new URL(request.url).pathname;

  if (pathname === "/line/webhook") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }
    return handleWebhook(request, env);
  }

  if (!pathname.startsWith("/api/line/")) return null;

  const denied = requireKey(request, env);
  if (denied) return denied;

  if (pathname === "/api/line/status" && request.method === "GET") {
    return handleStatus(env);
  }

  if (!env.LINE_STORE) {
    return json({ error: "NOT_CONFIGURED", message: "保存先（KV）が未接続です" }, 503);
  }

  if (pathname === "/api/line/threads" && request.method === "GET") return handleThreads(env);
  if (pathname === "/api/line/messages" && request.method === "GET") return handleMessages(request, env);
  if (pathname === "/api/line/send" && request.method === "POST") return handleSend(request, env);
  if (pathname === "/api/line/analyze" && request.method === "POST") return handleAnalyze(request, env);

  return json({ error: "NOT_FOUND" }, 404);
}
