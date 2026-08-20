import assert from "node:assert/strict";
import { decideRetry } from "./delegate.ts";

// 1. 429 message -> "continue" when failed + sessionId
assert.deepEqual(
  decideRetry({
    status: "failed",
    sessionId: "test-session-id",
    lastErrorMessage: "Rate limit exceeded (429)",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  { kind: "continue" },
  "429 error should trigger continue retry",
);

// 2. OpenAI API error (400) -> null
assert.deepEqual(
  decideRetry({
    status: "failed",
    sessionId: "test-session-id",
    lastErrorMessage: "OpenAI API error (400): 400 The requested model is not supported.",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  null,
  "400 error should not retry",
);

// 3. insufficient_quota -> null
assert.deepEqual(
  decideRetry({
    status: "failed",
    sessionId: "test-session-id",
    lastErrorMessage: "insufficient_quota: You exceeded your current quota",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  null,
  "insufficient_quota should not retry",
);

// 4. 503 Service Unavailable -> "continue"
assert.deepEqual(
  decideRetry({
    status: "failed",
    sessionId: "test-session-id",
    lastErrorMessage: "503 Service Unavailable",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  { kind: "continue" },
  "503 error should trigger continue retry",
);

// 5. no sessionId -> null
assert.deepEqual(
  decideRetry({
    status: "failed",
    sessionId: undefined,
    lastErrorMessage: "503 Service Unavailable",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  null,
  "missing sessionId should not retry",
);

// 6. limited -> null
assert.deepEqual(
  decideRetry({
    status: "limited",
    limit: "timeout",
    sessionId: "test-session-id",
    lastErrorMessage: "503 Service Unavailable",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  null,
  "limit should not retry",
);

// 7. cancelled -> null
assert.deepEqual(
  decideRetry({
    status: "cancelled",
    sessionId: "test-session-id",
    lastErrorMessage: "503 Service Unavailable",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  null,
  "cancelled should not retry",
);

// 8. completed + empty latestText + hasWork -> "summary" then next call with summaryRetriesUsed=1 -> null
assert.deepEqual(
  decideRetry({
    status: "completed",
    sessionId: "test-session-id",
    lastErrorMessage: "",
    latestText: "",
    hasWork: true,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 0,
  }),
  { kind: "summary" },
  "completed with empty text and work should trigger summary retry",
);

assert.deepEqual(
  decideRetry({
    status: "completed",
    sessionId: "test-session-id",
    lastErrorMessage: "",
    latestText: "",
    hasWork: true,
    continueRetriesUsed: 0,
    summaryRetriesUsed: 1,
  }),
  null,
  "summary retry cap should return null",
);

// 9. continueRetriesUsed=2 -> null
assert.deepEqual(
  decideRetry({
    status: "failed",
    sessionId: "test-session-id",
    lastErrorMessage: "503 Service Unavailable",
    latestText: "",
    hasWork: false,
    continueRetriesUsed: 2,
    summaryRetriesUsed: 0,
  }),
  null,
  "continue retry cap (2) should return null",
);

console.log("All unit tests passed!");
