const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const { authenticate } = require("../middleware/auth");
const { rbac } = require("../middleware/rbac");
const { webhooks, webhookDeliveries } = require("../store");

const router = express.Router();

/**
 * POST /webhooks/register
 * Merchants register the URL they want payment callbacks delivered to.
 *
 * We generate a signing secret here. Merchants use it to verify
 * incoming webhook payloads via HMAC-SHA256.
 */
router.post(
  "/register",
  authenticate,
  rbac("merchant", "admin"),
  [
    body("url").isURL({ require_tld: false, require_protocol: true }).withMessage("url must be a valid URL"),
    body("events")
      .optional()
      .isArray()
      .withMessage("events must be an array")
      .custom((val) => {
        const allowed = ["payment.success", "payment.failed", "refund.success", "refund.failed"];
        return val.every((e) => allowed.includes(e));
      })
      .withMessage("events contains unrecognised event types"),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "VALIDATION_ERROR", details: errors.array() });
    }

    const merchantId = req.user.merchantId || req.user.userId;
    const secret = uuidv4().replace(/-/g, ""); // 32-char hex secret

    webhooks.set(merchantId, {
      url: req.body.url,
      secret,
      events: req.body.events || ["payment.success", "payment.failed"],
      registeredAt: new Date().toISOString(),
    });

    res.status(201).json({
      message: "Webhook registered. Store the signing secret — it won't be shown again.",
      webhook: {
        url: req.body.url,
        events: webhooks.get(merchantId).events,
        signingSecret: secret,
        note: "Verify incoming webhooks by checking: sha256=HMAC(secret, rawBody) === X-Signature header",
      },
    });
  }
);

/**
 * GET /webhooks/deliveries
 * Returns the delivery log for the calling merchant (or all for admin).
 * Useful for debugging failed deliveries.
 */
router.get("/deliveries", authenticate, rbac("merchant", "admin"), (req, res) => {
  const merchantId = req.user.merchantId || req.user.userId;

  const deliveries =
    req.user.role === "admin"
      ? webhookDeliveries
      : webhookDeliveries.filter((d) => d.merchantId === merchantId);

  res.json({
    total: deliveries.length,
    deliveries: deliveries.slice(-50).reverse(), // last 50, newest first
  });
});

/**
 * GET /webhooks/config
 * Returns the current webhook config for the merchant (secret redacted).
 */
router.get("/config", authenticate, rbac("merchant", "admin"), (req, res) => {
  const merchantId = req.user.merchantId || req.user.userId;
  const config = webhooks.get(merchantId);

  if (!config) {
    return res.status(404).json({ error: "NO_WEBHOOK_REGISTERED", message: "Register a webhook first via POST /webhooks/register" });
  }

  res.json({
    url: config.url,
    events: config.events,
    registeredAt: config.registeredAt,
    signingSecret: "***redacted***",
  });
});

module.exports = router;
