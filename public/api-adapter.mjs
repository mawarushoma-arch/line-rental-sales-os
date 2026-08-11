import { NORMALIZED_MODEL_CONTRACTS } from "./model-contract.mjs";

const MODES = new Set(["ready", "loading", "stale", "empty", "error", "timeout"]);

export class RentalAdapterError extends Error {
  constructor(code, message, retryable = true) {
    super(message);
    this.name = "RentalAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

const wait = (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

/**
 * Adapter used by the prototype. It deliberately returns only connection metadata;
 * the normalized sample records remain bundled in app.js until the contracted API is mapped.
 */
export class MockRentalDataAdapter {
  constructor(options = {}) {
    const {
      search = globalThis.location?.search || "",
      delayMs = 180,
      endpoint = "/api/mock/bootstrap",
      transport = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null,
      timeoutMs = 3_500,
    } = options;
    const requestedMode = new URLSearchParams(search).get("api") || "ready";
    this.mode = MODES.has(requestedMode) ? requestedMode : "ready";
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.endpoint = endpoint;
    this.transport = transport;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 3_500);
  }

  async bootstrap() {
    const delay = this.mode === "loading" ? Math.max(this.delayMs, 900) : this.delayMs;
    if (delay) await wait(delay);
    if (this.mode === "error") {
      throw new RentalAdapterError("NETWORK", "モックAPIへ接続できませんでした");
    }
    if (this.mode === "timeout") {
      throw new RentalAdapterError("TIMEOUT", "応答が時間内に返りませんでした");
    }

    let contract;
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    let timeoutHandle;
    try {
      if (typeof this.transport !== "function") throw new Error("Transport unavailable");
      const request = (async () => {
        const response = await this.transport(this.endpoint, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: abortController?.signal,
        });
        if (response.status === 401 || response.status === 403) {
          throw new RentalAdapterError("AUTH", "営業権限を確認できませんでした", false);
        }
        if (!response.ok) {
          throw new RentalAdapterError("NETWORK", `モックAPIが HTTP ${response.status} を返しました`);
        }
        try {
          return await response.json();
        } catch {
          throw new RentalAdapterError("CONTRACT", "モックAPIの応答形式を確認してください", false);
        }
      })();
      const timeout = new Promise((_, reject) => {
        timeoutHandle = globalThis.setTimeout(() => {
          abortController?.abort();
          reject(new RentalAdapterError("TIMEOUT", "応答が時間内に返りませんでした"));
        }, this.timeoutMs);
      });
      contract = await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof RentalAdapterError) throw error;
      throw new RentalAdapterError("NETWORK", "モックAPIへ接続できませんでした");
    } finally {
      globalThis.clearTimeout(timeoutHandle);
    }
    if (
      contract?.ok !== true ||
      contract.source !== "mock" ||
      !Array.isArray(contract.normalizedModels) ||
      !Object.entries(NORMALIZED_MODEL_CONTRACTS).every(([model, requiredFields]) => {
        const receivedFields = contract.modelContracts?.[model];
        return (
          contract.normalizedModels.includes(model) &&
          Array.isArray(receivedFields) &&
          requiredFields.every((field) => receivedFields.includes(field))
        );
      })
    ) {
      throw new RentalAdapterError("CONTRACT", "モックAPIの応答形式を確認してください", false);
    }

    return Object.freeze({
      source: "mock",
      mode: this.mode,
      fetchedAt: "2026-08-11T11:20:00+09:00",
      sourceUpdatedAt: this.mode === "stale" ? "2026-08-09T09:00:00+09:00" : "2026-08-11T11:08:00+09:00",
      stale: this.mode === "stale",
      empty: this.mode === "empty",
      contract,
    });
  }
}

/** Contract placeholder for the post-MVP integration. No endpoint names are guessed here. */
export class ItandiRentalDataAdapter {
  constructor({ specification, transport } = {}) {
    this.specification = specification;
    this.transport = transport;
  }

  async bootstrap() {
    throw new RentalAdapterError(
      "NOT_CONFIGURED",
      "契約済みITANDI API仕様書と検証環境が未登録です",
      false,
    );
  }
}

export function createRentalDataAdapter(options) {
  return new MockRentalDataAdapter(options);
}

export function fingerprintReplyBody(body) {
  const value = String(body || "").trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Explicit confirmation record used only by the prototype's mock send flow. */
export function createMockReplyApproval({ draftId, body, approvedBy }) {
  const cleanDraftId = String(draftId || "").trim();
  const cleanBody = String(body || "").trim();
  const cleanApprover = String(approvedBy || "").trim();
  if (!cleanDraftId || !cleanBody || !cleanApprover) {
    throw new RentalAdapterError("UNAPPROVED_REPLY", "営業確認が完了していません", false);
  }
  return Object.freeze({
    confirmed: true,
    draftId: cleanDraftId,
    bodyFingerprint: fingerprintReplyBody(cleanBody),
    approvedBy: cleanApprover,
    approvedAt: new Date().toISOString(),
  });
}

/** Structural allow-list DTO. Production creates and verifies approval on the server. */
export function createApprovedReplyDTO({ customerId, draftId, body, approval }) {
  const cleanBody = String(body || "").trim();
  const cleanDraftId = String(draftId || "").trim();
  const expectedFingerprint = fingerprintReplyBody(cleanBody);
  if (!customerId || !cleanDraftId || !cleanBody) {
    throw new RentalAdapterError("INVALID_REPLY", "返信本文を確認してください", false);
  }
  if (
    approval?.confirmed !== true ||
    approval.draftId !== cleanDraftId ||
    approval.bodyFingerprint !== expectedFingerprint ||
    !approval.approvedBy ||
    !approval.approvedAt
  ) {
    throw new RentalAdapterError("UNAPPROVED_REPLY", "営業確認後の本文と一致しません", false);
  }
  return Object.freeze({
    customerId: String(customerId),
    draftId: cleanDraftId,
    body: cleanBody,
    bodyFingerprint: expectedFingerprint,
    approvedBy: String(approval.approvedBy),
    approvedAt: String(approval.approvedAt),
  });
}

export class MockApprovedReplyGateway {
  constructor() {
    this.records = [];
  }

  get sendCount() {
    return this.records.length;
  }

  async sendApprovedReply(dto) {
    if (
      !dto?.customerId ||
      !dto?.draftId ||
      !dto?.approvedBy ||
      !dto?.approvedAt ||
      dto.bodyFingerprint !== fingerprintReplyBody(dto.body)
    ) {
      throw new RentalAdapterError("UNAPPROVED_REPLY", "未承認の返信は送信できません", false);
    }
    const record = Object.freeze({ ...dto, mockMessageId: `mock-message-${this.records.length + 1}` });
    this.records.push(record);
    return record;
  }
}
