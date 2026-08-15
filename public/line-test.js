/**
 * 公式LINE実機テスト画面。
 *
 * 本物の公式アカウントと送受信するので、モックのSPA（app.js）とは切り離してある。
 * 送信は「本文を確認 → 承認記録を作る → サーバーが指紋を作り直して突き合わせる」の順で、
 * 確認せずに送る経路は用意していない（docs/architecture.md 3-2）。
 */
import { createMockReplyApproval, fingerprintReplyBody } from "/api-adapter.mjs";

const KEY_STORAGE = "room-pilot:line-key";
const POLL_INTERVAL_MS = 4_000;
const OPERATOR = "employee:sato";

const main = document.getElementById("line-main");
const chipsRoot = document.getElementById("status-chips");
const brandRoot = document.getElementById("bot-brand");
const toastRoot = document.getElementById("line-toast");

const state = {
  key: window.localStorage.getItem(KEY_STORAGE) || "",
  status: null,
  threads: [],
  activeThreadId: null,
  activeThread: null,
  messages: [],
  cursor: "",
  draft: "",
  pending: null,
  sending: false,
  analysis: null,
  analyzing: false,
  loading: true,
  error: "",
};

let pollTimer = 0;
let toastTimer = 0;

function escapeHTML(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function toast(message, tone = "ok") {
  toastRoot.textContent = message;
  toastRoot.dataset.tone = tone;
  toastRoot.dataset.open = "true";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastRoot.dataset.open = "false";
  }, 4_000);
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

function initials(name) {
  return String(name || "友").trim().slice(0, 1);
}

/* ------------------------------------------------------------------ 通信 */

async function callApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "x-room-pilot-key": state.key,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401) {
    state.key = "";
    window.localStorage.removeItem(KEY_STORAGE);
    throw new Error("合言葉が違います");
  }
  if (!response.ok) {
    const error = new Error(payload?.message || `通信に失敗しました（${response.status}）`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function loadStatus() {
  state.status = await callApi("/api/line/status");
}

async function loadThreads() {
  const payload = await callApi("/api/line/threads");
  state.threads = payload.threads || [];
  if (state.activeThreadId) {
    state.activeThread =
      state.threads.find((thread) => thread.threadId === state.activeThreadId) || state.activeThread;
  }
}

async function loadMessages({ reset = false } = {}) {
  if (!state.activeThreadId) return;
  if (reset) {
    state.messages = [];
    state.cursor = "";
  }
  const params = new URLSearchParams({ thread: state.activeThreadId });
  if (state.cursor) params.set("since", state.cursor);
  const payload = await callApi(`/api/line/messages?${params}`);
  const incoming = payload.messages || [];
  if (incoming.length) {
    const known = new Set(state.messages.map((message) => message.id));
    state.messages = [...state.messages, ...incoming.filter((message) => !known.has(message.id))];
  }
  state.cursor = payload.cursor || state.cursor;
  if (payload.thread) state.activeThread = payload.thread;
  if (payload.analysis !== undefined) state.analysis = payload.analysis;
  return incoming.length;
}

async function runAnalysis() {
  if (!state.activeThreadId || state.analyzing) return;
  state.analyzing = true;
  render();
  try {
    const result = await callApi("/api/line/analyze", {
      method: "POST",
      body: JSON.stringify({ threadId: state.activeThreadId }),
    });
    state.analysis = result.analysis;
    toast(`${result.analysis.messageCount}件のやり取りから整理しました`);
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    state.analyzing = false;
    render();
  }
}

/* ------------------------------------------------------------------ 描画 */

const BRAND_LOGO = `<img class="brand-logo" src="/brand/header.png" width="613" height="96" alt="それ、LINEでええやん。｜不動産" />`;

function renderBrand() {
  const bot = state.status?.bot;
  const meta = bot
    ? `${bot.basicId}｜公式LINE実機テスト`
    : state.error || "接続を確認しています…";
  brandRoot.innerHTML = `${BRAND_LOGO}<p class="line-brand-meta">${escapeHTML(meta)}</p>`;
}

function renderChips() {
  if (!state.status) {
    chipsRoot.innerHTML = "";
    return;
  }
  const chips = [];
  const { secretConfigured, storeConfigured, webhookEndpoint, quota } = state.status;

  chips.push(
    secretConfigured
      ? '<span class="line-chip" data-tone="ok">署名検証 有効</span>'
      : '<span class="line-chip" data-tone="bad">チャネルシークレット未設定</span>',
  );
  if (!storeConfigured) {
    chips.push('<span class="line-chip" data-tone="bad">保存先 未接続</span>');
  }
  if (webhookEndpoint?.endpoint) {
    chips.push(
      webhookEndpoint.active
        ? '<span class="line-chip" data-tone="ok">Webhook 有効</span>'
        : '<span class="line-chip" data-tone="warn">Webhook 停止中</span>',
    );
  } else {
    chips.push('<span class="line-chip" data-tone="warn">Webhook 未設定</span>');
  }
  if (quota && Number.isFinite(quota.limit)) {
    const left = Math.max(0, quota.limit - quota.used);
    chips.push(
      `<span class="line-chip" data-tone="${left > 20 ? "info" : "warn"}">プッシュ残り ${left} / ${quota.limit} 通</span>`,
    );
  } else if (quota?.type === "none") {
    chips.push('<span class="line-chip" data-tone="info">プッシュ無制限</span>');
  }
  chipsRoot.innerHTML = chips.join("");
}

function gateView() {
  return `
    <section class="line-card">
      <h2>合言葉を入れてください</h2>
      <p>この画面は本物の公式アカウントとつながっています。誰でも開けないよう、合言葉を知っている人だけが使えます。</p>
      <form id="gate-form">
        <label class="line-field">
          <span>合言葉</span>
          <input class="line-input" id="gate-input" type="password" autocomplete="off"
            inputmode="text" placeholder="配布された合言葉" value="" />
        </label>
        <button class="line-button" type="submit">開く</button>
      </form>
    </section>`;
}

function setupView() {
  const bot = state.status?.bot;
  const addUrl = bot?.basicId ? `https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}` : "";
  return `
    <section class="line-card">
      <h2>まだ受信がありません</h2>
      <p>公式アカウントを友だち追加して、LINEからメッセージを送ってください。ここに届きます。</p>
      <ol class="line-steps">
        <li>スマホのLINEで <span class="line-inline-code">${escapeHTML(bot?.basicId || "@125fhbgr")}</span> を友だち追加する</li>
        <li>そのトークに「テスト」と送る</li>
        <li>数秒でこの画面に表示される（自動で更新します）</li>
      </ol>
      ${addUrl ? `<p style="margin-top:12px"><a class="line-button" style="display:block;text-align:center;text-decoration:none" href="${escapeHTML(addUrl)}">LINEで友だち追加を開く</a></p>` : ""}
    </section>`;
}

function warningsView() {
  if (state.status?.secretConfigured && state.status?.webhookEndpoint?.endpoint) return "";
  const rows = [];
  if (!state.status?.secretConfigured) {
    rows.push(
      "<li><strong>チャネルシークレットが未設定</strong>です。署名を検証できないので、受信は安全のため断っています。</li>",
    );
  }
  if (!state.status?.webhookEndpoint?.endpoint) {
    rows.push("<li><strong>Webhookの宛先が未登録</strong>です。LINE側からこの画面へ届きません。</li>");
  }
  return `
    <section class="line-card" style="border-color:#f3d6b0;background:var(--warning-soft)">
      <h2>受信の準備が終わっていません</h2>
      <ul class="line-steps">${rows.join("")}</ul>
    </section>`;
}

function threadListView() {
  if (!state.threads.length) return setupView();
  return `
    <p class="line-section-title">トーク（${state.threads.length}件）</p>
    <ul class="line-thread-list">
      ${state.threads
        .map(
          (thread) => `
        <li>
          <button class="line-thread" type="button" data-action="open-thread" data-thread="${escapeHTML(thread.threadId)}">
            ${
              thread.pictureUrl
                ? `<img class="line-avatar" src="${escapeHTML(thread.pictureUrl)}" alt="" width="44" height="44" />`
                : `<span class="line-avatar">${escapeHTML(initials(thread.displayName))}</span>`
            }
            <span class="line-thread-body">
              <span class="line-thread-name">${escapeHTML(thread.displayName)}${thread.blocked ? "（ブロック中）" : ""}</span>
              <span class="line-thread-last">${escapeHTML(thread.lastDirection === "out" ? "自分: " : "")}${escapeHTML(thread.lastBody || "（本文なし）")}</span>
            </span>
            <span class="line-thread-time">${escapeHTML(formatTime(thread.lastAt))}</span>
          </button>
        </li>`,
        )
        .join("")}
    </ul>`;
}

function messageMeta(message) {
  if (message.direction === "in") return `${formatTime(message.at)}・受信`;
  if (message.status === "failed") return `${formatTime(message.at)}・送信失敗`;
  const route = message.method === "reply" ? "応答メッセージ（無料）" : "プッシュ送信";
  return `${formatTime(message.at)}・${route}`;
}

function composerView() {
  const thread = state.activeThread;
  const replyLeft = Math.round((thread?.replyWindowMsLeft || 0) / 1000);
  const route =
    replyLeft > 0
      ? `いまなら<strong>応答メッセージ</strong>で送るので、今月の送信数を消費しません（残り約${replyLeft}秒）。`
      : "<strong>プッシュ送信</strong>になります。今月の送信可能数を1通消費します。";

  if (state.pending) {
    return `
      <section class="line-composer">
        <div class="line-preview">
          <p class="line-preview-label">この内容が実際にLINEへ送信されます</p>
          <p class="line-preview-body">${escapeHTML(state.pending.body)}</p>
          <p class="line-preview-route">${route}</p>
        </div>
        <div class="line-button-row">
          <button class="line-button line-button-ghost" type="button" data-action="cancel-send" ${state.sending ? "disabled" : ""}>書き直す</button>
          <button class="line-button" type="button" data-action="confirm-send" ${state.sending ? "disabled" : ""}>${state.sending ? "送信中…" : "この内容で送信"}</button>
        </div>
      </section>`;
  }

  return `
    <section class="line-composer">
      <p class="line-composer-note">本番の公式アカウントから、実際に相手のLINEへ届きます。</p>
      <form id="send-form">
        <label class="line-field">
          <span class="sr-only">返信本文</span>
          <textarea class="line-textarea" id="send-body" rows="3" placeholder="返信を入力">${escapeHTML(state.draft)}</textarea>
        </label>
        <button class="line-button" type="submit">送信内容を確認</button>
      </form>
    </section>`;
}

const STATUS_LABEL = { inferred: "推定", unknown: "未確認", confirmed: "確認済み" };

/**
 * 会話から作った要約と条件。AIが埋めた値は必ず「推定」として出し、
 * 根拠になった顧客の発言を並べて、営業が自分で裏を取れるようにする。
 */
function analysisView() {
  const analysis = state.analysis;
  const button = `
    <button class="line-button line-button-ghost" type="button" data-action="analyze" ${state.analyzing ? "disabled" : ""}>
      ${state.analyzing ? "整理しています…" : analysis ? "最新のやり取りで作り直す" : "AIで要約と条件を整理"}
    </button>`;

  if (!analysis) {
    return `<section class="line-analysis">${button}</section>`;
  }

  const known = analysis.items.filter((item) => item.status !== "unknown");
  const unknown = analysis.items.filter((item) => item.status === "unknown");

  return `
    <section class="line-analysis">
      <div class="line-analysis-head">
        <h3>会話の要約</h3>
        <span class="line-analysis-meta">${escapeHTML(String(analysis.messageCount))}件から・${escapeHTML(formatTime(analysis.at))}</span>
      </div>
      <p class="line-analysis-summary">${escapeHTML(analysis.summary || "要約を作れませんでした。")}</p>

      <h3>読み取れた条件</h3>
      ${
        known.length
          ? `<dl class="line-conditions">
        ${known
          .map(
            (item) => `
          <div class="line-condition">
            <dt>${escapeHTML(item.label)}<span class="line-status" data-status="${escapeHTML(item.status)}">${escapeHTML(STATUS_LABEL[item.status] || item.status)}</span></dt>
            <dd>${escapeHTML(item.value)}</dd>
            ${item.quote ? `<dd class="line-quote">「${escapeHTML(item.quote)}」</dd>` : ""}
          </div>`,
          )
          .join("")}
      </dl>`
          : '<p class="line-analysis-summary">まだ条件を読み取れる発言がありません。</p>'
      }

      ${
        unknown.length
          ? `<p class="line-unknown">未確認：${unknown.map((item) => escapeHTML(item.label)).join("・")}</p>`
          : ""
      }

      ${
        analysis.questions?.length
          ? `<h3>次に聞くとよいこと</h3>
        <ul class="line-questions">${analysis.questions.map((question) => `<li>${escapeHTML(question)}</li>`).join("")}</ul>`
          : ""
      }

      <p class="line-analysis-note">AIの推定です。金額・日付・空室は必ず裏を取ってから提案してください。</p>
      ${button}
    </section>`;
}

function talkView() {
  const thread = state.activeThread;
  const log = state.messages.length
    ? state.messages
        .map(
          (message) => `
        <li class="line-msg" data-direction="${escapeHTML(message.direction)}" data-status="${escapeHTML(message.status)}">
          <span class="line-bubble">${escapeHTML(message.body)}</span>
          <span class="line-msg-meta">${escapeHTML(messageMeta(message))}</span>
        </li>`,
        )
        .join("")
    : '<li class="line-empty-log">まだメッセージがありません。<br />LINEから送ると数秒で表示されます。</li>';

  return `
    <div class="line-talk">
      <div class="line-talk-head">
        <button class="line-back" type="button" data-action="close-thread" aria-label="一覧へ戻る">‹</button>
        ${
          thread?.pictureUrl
            ? `<img class="line-avatar" src="${escapeHTML(thread.pictureUrl)}" alt="" width="36" height="36" />`
            : `<span class="line-avatar">${escapeHTML(initials(thread?.displayName))}</span>`
        }
        <span class="line-thread-body">
          <span class="line-thread-name">${escapeHTML(thread?.displayName || "友だち")}</span>
          <span class="line-thread-last">${thread?.blocked ? "ブロック中のため送信できません" : "公式LINEのトーク"}</span>
        </span>
      </div>
      <ol class="line-talk-log" id="talk-log">${log}</ol>
      ${analysisView()}
      ${thread?.blocked ? "" : composerView()}
    </div>`;
}

function render() {
  renderBrand();
  renderChips();

  if (!state.key) {
    main.innerHTML = gateView();
    main.querySelector("#gate-input")?.focus();
    return;
  }
  if (state.loading && !state.status) {
    main.innerHTML = '<section class="line-card"><p>接続を確認しています…</p></section>';
    return;
  }
  if (state.error) {
    main.innerHTML = `<section class="line-card"><h2>読み込めませんでした</h2><p>${escapeHTML(state.error)}</p><button class="line-button" type="button" data-action="refresh">もう一度試す</button></section>`;
    return;
  }

  main.innerHTML = state.activeThreadId ? talkView() : `${warningsView()}${threadListView()}`;

  const log = document.getElementById("talk-log");
  if (log) log.scrollTop = log.scrollHeight;
}

/* ------------------------------------------------------------------ 操作 */

async function refreshAll({ resetMessages = false } = {}) {
  if (!state.key) {
    render();
    return;
  }
  try {
    state.error = "";
    await loadStatus();
    await loadThreads();
    if (state.activeThreadId) await loadMessages({ reset: resetMessages });
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function pollOnce() {
  if (!state.key || document.hidden || state.sending) return;
  try {
    await loadThreads();
    if (state.activeThreadId) {
      const added = await loadMessages();
      if (!added) {
        // 相手の情報だけ更新されている場合があるので、一覧の表示は入れ替える
        render();
        return;
      }
    }
    render();
  } catch {
    // 一時的な失敗は次の巡回で拾う
  }
}

function startPolling() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(pollOnce, POLL_INTERVAL_MS);
}

async function sendPending() {
  if (!state.pending || state.sending) return;
  state.sending = true;
  render();

  const { body, approval, draftId } = state.pending;
  try {
    const result = await callApi("/api/line/send", {
      method: "POST",
      body: JSON.stringify({
        threadId: state.activeThreadId,
        body,
        draftId,
        idempotencyKey: draftId,
        confirmed: approval.confirmed,
        bodyFingerprint: approval.bodyFingerprint,
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
      }),
    });
    state.pending = null;
    state.draft = "";
    toast(result.method === "reply" ? "応答メッセージで送信しました" : "プッシュ送信しました");
  } catch (error) {
    // 失敗は成功へ丸めない。本文は戻して、送るならもう一度確認してもらう
    state.pending = null;
    state.draft = body;
    toast(error.message, "bad");
  } finally {
    state.sending = false;
    await refreshAll();
  }
}

document.addEventListener("submit", (event) => {
  if (event.target.id === "gate-form") {
    event.preventDefault();
    const value = document.getElementById("gate-input")?.value.trim() || "";
    if (!value) return;
    state.key = value;
    window.localStorage.setItem(KEY_STORAGE, value);
    state.loading = true;
    render();
    refreshAll();
    return;
  }

  if (event.target.id === "send-form") {
    event.preventDefault();
    const body = document.getElementById("send-body")?.value.trim() || "";
    if (!body) {
      toast("本文を入力してください", "bad");
      return;
    }
    const draftId = `live-${state.activeThreadId}-${Date.now()}`;
    try {
      // 明示確認の記録。サーバーが本文から指紋を作り直して突き合わせる
      const approval = createMockReplyApproval({ draftId, body, approvedBy: OPERATOR });
      if (approval.bodyFingerprint !== fingerprintReplyBody(body)) {
        throw new Error("本文の確認に失敗しました");
      }
      state.draft = body;
      state.pending = { body, approval, draftId };
      render();
    } catch (error) {
      toast(error.message || "確認できませんでした", "bad");
    }
  }
});

document.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const { action, thread } = control.dataset;

  if (action === "refresh") {
    state.loading = true;
    render();
    refreshAll();
  }
  if (action === "open-thread" && thread) {
    state.activeThreadId = thread;
    state.activeThread = state.threads.find((row) => row.threadId === thread) || null;
    state.pending = null;
    state.draft = "";
    state.analysis = null;
    refreshAll({ resetMessages: true });
  }
  if (action === "close-thread") {
    state.activeThreadId = null;
    state.activeThread = null;
    state.messages = [];
    state.cursor = "";
    state.pending = null;
    state.analysis = null;
    render();
  }
  if (action === "cancel-send") {
    state.pending = null;
    render();
  }
  if (action === "confirm-send") sendPending();
  if (action === "analyze") runAnalysis();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "send-body") state.draft = event.target.value;
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollOnce();
});

render();
refreshAll();
startPolling();
