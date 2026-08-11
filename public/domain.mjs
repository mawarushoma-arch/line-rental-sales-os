export const CASE_STAGE_ORDER = Object.freeze([
  "追客中",
  "内見調整",
  "申込準備",
  "審査中",
  "契約準備",
  "契約済",
]);
export const CANDIDATE_STATUSES = Object.freeze(["unreviewed", "liked", "skipped", "reserved"]);

function copyRecord(record) {
  return {
    liked: Array.isArray(record?.liked) ? [...record.liked] : [],
    skipped: Array.isArray(record?.skipped) ? [...record.skipped] : [],
  };
}

/** Apply one local decision and retain enough information for an exact one-step undo. */
export function applyPropertyDecision(decisions, customerId, propertyId, action) {
  if (!customerId || !propertyId || !["liked", "skipped"].includes(action)) {
    return { decisions, undo: null };
  }

  const previous = copyRecord(decisions?.[customerId]);
  const nextRecord = copyRecord(previous);
  nextRecord.liked = nextRecord.liked.filter((id) => id !== propertyId);
  nextRecord.skipped = nextRecord.skipped.filter((id) => id !== propertyId);
  nextRecord[action].push(propertyId);

  return {
    decisions: { ...decisions, [customerId]: nextRecord },
    undo: { customerId, propertyId, action, previous },
  };
}

/** Restore the exact local state that existed before applyPropertyDecision. */
export function undoPropertyDecision(decisions, undo) {
  if (!undo?.customerId || !undo.previous) return { decisions, restored: false };
  return {
    decisions: { ...decisions, [undo.customerId]: copyRecord(undo.previous) },
    restored: true,
  };
}

/** Local decisions override the adapter-provided seed status. */
export function effectiveCandidateStatus(seedStatus, localRecord, propertyId) {
  if (localRecord?.liked?.includes(propertyId)) return "liked";
  if (localRecord?.skipped?.includes(propertyId)) return "skipped";
  return CANDIDATE_STATUSES.includes(seedStatus) ? seedStatus : "unreviewed";
}

export function moveItem(items, itemId, direction) {
  const next = [...items];
  const from = next.indexOf(itemId);
  const to = from + Number(direction);
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function stageAtOrBeyond(stage, minimumStage) {
  const current = CASE_STAGE_ORDER.indexOf(stage);
  const minimum = CASE_STAGE_ORDER.indexOf(minimumStage);
  return current >= 0 && minimum >= 0 && current >= minimum;
}

export function isKnownCaseStage(stage) {
  return CASE_STAGE_ORDER.includes(stage);
}

export function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export function containsInternalFragment(body, fragments) {
  const normalizedBody = String(body || "").normalize("NFKC");
  const safeFragments = Array.isArray(fragments) ? fragments : [];
  if (/(?:キーボックス|暗証|鍵メモ|社内限定|管理会社向け備考|元付)/u.test(normalizedBody)) {
    return true;
  }
  const compactBody = normalizedBody.replaceAll(/\s+/g, "");
  if (/(?:^|[^A-Z])AD(?:は|が|[:：=])?\d{1,4}(?:[^0-9]|$)/iu.test(compactBody)) {
    return true;
  }
  const internalCodes = new Set(
    safeFragments.flatMap((fragment) =>
      String(fragment || "")
        .normalize("NFKC")
        .match(/[A-Z][\s-]?\d{1,4}/giu) || [],
    ).map((code) => code.replaceAll(/[\s-]+/g, "").toUpperCase()),
  );
  const bodyCodes = compactBody.match(/[A-Z][\s-]?\d{1,4}/giu) || [];
  if (bodyCodes.some((code) => internalCodes.has(code.replaceAll(/[\s-]+/g, "").toUpperCase()))) return true;
  return safeFragments.some((fragment) => {
    const normalizedFragment = String(fragment || "").trim().normalize("NFKC");
    return normalizedFragment.length >= 4 && normalizedBody.includes(normalizedFragment);
  });
}

export function validateNormalizedModels(models) {
  const errors = [];
  const requiredArrays = [
    "Customer",
    "Property",
    "SearchCondition",
    "CandidateProperty",
    "Viewing",
    "Case",
    "TodayAction",
  ];
  for (const name of requiredArrays) {
    if (!Array.isArray(models?.[name])) errors.push(`${name} must be an array`);
  }
  if (!models?.DisplayPreference || typeof models.DisplayPreference !== "object") {
    errors.push("DisplayPreference must be an object");
  }
  if (errors.length) return errors;

  const customerIds = new Set(models.Customer.map((item) => item.id));
  const propertyIds = new Set(models.Property.map((item) => item.id));
  const validDate = (value) => Number.isFinite(Date.parse(value));

  for (const customer of models.Customer) {
    if (!customer.id || !customer.status || !validDate(customer.lastContactAt)) {
      errors.push(`Customer ${customer.id || "(missing id)"} has an invalid contract`);
    }
  }
  for (const condition of models.SearchCondition) {
    if (
      !condition.id ||
      !customerIds.has(condition.customerId) ||
      !validDate(condition.updatedAt) ||
      !Array.isArray(condition.items) ||
      condition.items.some((item) => !item.key || !item.label || !["confirmed", "inferred", "unknown"].includes(item.status))
    ) {
      errors.push(`SearchCondition ${condition.id || "(missing id)"} has an invalid contract`);
    }
  }
  for (const property of models.Property) {
    if (
      !property.id ||
      !validDate(property.listedAt) ||
      (property.sourceUpdatedAt != null && !validDate(property.sourceUpdatedAt)) ||
      !validDate(property.fetchedAt) ||
      !Number.isInteger(property.rentYen) ||
      !Number.isInteger(property.managementFeeYen) ||
      typeof property.internal !== "object"
    ) {
      errors.push(`Property ${property.id || "(missing id)"} has an invalid contract`);
    }
  }
  for (const candidate of models.CandidateProperty) {
    if (
      !customerIds.has(candidate.customerId) ||
      !propertyIds.has(candidate.propertyId) ||
      !CANDIDATE_STATUSES.includes(candidate.status) ||
      !Number.isFinite(candidate.matchScore) ||
      !Array.isArray(candidate.matchReasons)
    ) {
      errors.push(`CandidateProperty ${candidate.id || "(missing id)"} has an invalid contract`);
    }
  }
  for (const viewing of models.Viewing) {
    if (!customerIds.has(viewing.customerId) || !propertyIds.has(viewing.propertyId)) {
      errors.push(`Viewing ${viewing.id || "(missing id)"} has an invalid reference`);
    }
  }
  for (const caseItem of models.Case) {
    if (
      !customerIds.has(caseItem.customerId) ||
      (caseItem.propertyId && !propertyIds.has(caseItem.propertyId)) ||
      !isKnownCaseStage(caseItem.stage) ||
      !validDate(caseItem.dueAt) ||
      !validDate(caseItem.updatedAt)
    ) {
      errors.push(`Case ${caseItem.id || "(missing id)"} has an invalid contract`);
    }
  }
  for (const action of models.TodayAction) {
    if (
      !customerIds.has(action.customerId) ||
      !validDate(action.dueAt) ||
      !["todo", "done"].includes(action.status)
    ) {
      errors.push(`TodayAction ${action.id || "(missing id)"} has an invalid contract`);
    }
  }
  const preference = models.DisplayPreference;
  if (
    !preference.salesUserId ||
    !Array.isArray(preference.widgets) ||
    !Array.isArray(preference.propertyFields) ||
    !validDate(preference.updatedAt)
  ) {
    errors.push("DisplayPreference has an invalid contract");
  }
  return errors;
}
