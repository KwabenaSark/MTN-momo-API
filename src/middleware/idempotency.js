const { idempotencyKeys, transactions } = require("../store");

const KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * idempotency — enforces per-merchant idempotent POSTs.
 *
 * How it works:
 *  1. Client sends `Idempotency-Key: <uuid>` header on every payment request.
 *  2. If we've never seen this key → proceed, cache the eventual response.
 *  3. If we have seen it AND the original request finished → replay the
 *     cached response (same status code, same body) without re-processing.
 *  4. If we have seen it but it's still in-flight → return 409 Conflict.
 *
 * Why this matters in mobile money:
 *  - Network timeouts are common on 2G/3G.
 *  - Without idempotency, a client retry can debit the subscriber twice.
 *  - MTN MoMo's own API enforces exactly this pattern (X-Reference-Id header).
 *
 * Scope: keyed per merchant so MERCH-001's key "abc" doesn't collide
 * with MERCH-002's key "abc".
 */
function idempotency(req, res, next) {
  const key = req.headers["idempotency-key"];

  if (!key) {
    return res.status(400).json({
      error: "MISSING_IDEMPOTENCY_KEY",
      message:
        "An Idempotency-Key header is required for this request. " +
        "Generate a UUID per payment attempt and reuse it on retries.",
    });
  }

  const merchantId = req.user?.merchantId || req.user?.userId;
  const scopedKey = `${merchantId}::${key}`;

  const existing = idempotencyKeys.get(scopedKey);

  if (existing) {
    // Check TTL
    const age = Date.now() - existing.createdAt;
    if (age > KEY_TTL_MS) {
      idempotencyKeys.delete(scopedKey);
      // Fall through to process as new
    } else if (existing.status === "IN_FLIGHT") {
      return res.status(409).json({
        error: "REQUEST_IN_FLIGHT",
        message:
          "A request with this Idempotency-Key is already being processed. " +
          "Wait for it to complete before retrying.",
      });
    } else {
      // Replay cached response
      res.set("X-Idempotent-Replay", "true");
      return res.status(existing.responseStatus).json(existing.responseBody);
    }
  }

  // Mark as in-flight
  idempotencyKeys.set(scopedKey, {
    createdAt: Date.now(),
    status: "IN_FLIGHT",
    responseStatus: null,
    responseBody: null,
  });

  // Intercept res.json to cache the response before sending
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const record = idempotencyKeys.get(scopedKey);
    if (record) {
      record.status = "COMPLETE";
      record.responseStatus = res.statusCode;
      record.responseBody = body;
    }
    return originalJson(body);
  };

  req._idempotencyScopedKey = scopedKey;
  next();
}

module.exports = { idempotency };
