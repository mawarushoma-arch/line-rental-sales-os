export const NORMALIZED_MODEL_CONTRACTS = Object.freeze({
  Customer: ["id", "status", "lastContactAt", "searchConditionId"],
  Property: ["id", "sourceUpdatedAt", "fetchedAt", "rentYen", "managementFeeYen", "internal"],
  SearchCondition: ["id", "customerId", "items", "updatedAt"],
  CandidateProperty: ["id", "customerId", "propertyId", "status", "matchScore", "matchReasons"],
  Viewing: ["id", "customerId", "propertyId", "date", "time", "keyConfirmed", "vacancyConfirmed"],
  Case: ["id", "customerId", "stage", "dueAt", "updatedAt"],
  TodayAction: ["id", "kind", "customerId", "dueAt", "status"],
  DisplayPreference: ["salesUserId", "widgets", "propertyFields", "updatedAt"],
});

export const MOCK_HEALTH_PAYLOAD = Object.freeze({
  ok: true,
  service: "room-pilot-mock",
  apiConnected: false,
});

export const MOCK_BOOTSTRAP_PAYLOAD = Object.freeze({
  ok: true,
  source: "mock",
  normalizedModels: Object.keys(NORMALIZED_MODEL_CONTRACTS),
  modelContracts: NORMALIZED_MODEL_CONTRACTS,
  nextIntegration: ["ITANDI specification mapping", "verification environment"],
});
