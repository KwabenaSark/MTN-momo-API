const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { authenticate } = require("../middleware/auth");
const { rbac } = require("../middleware/rbac");
const { idempotency } = require("../middleware/idempotency");
const { initiatePayment, initiateRefund } = require("../services/momoService");
const { transactions } = require("../store");
require('dotenv').config();

const router = express.Router();

// ─── Validation helpers ───────────────────────────────────────────────────────

const phoneRegex = /^\d{11,13}$/;

const sandboxPhoneRegex = /^\d{8,15}$/; // permissive for sandbox test numbers

const paymentValidation = [
  body("amount")
    .isFloat({ min: 0.01 })
    .withMessage("amount must be a positive number"),
  body("currency")
    .optional()
    .isIn(["GHS", "USD", "EUR"])
    .withMessage("currency must be GHS, USD, or EUR"),
  body("phoneNumber")
    .matches(process.env.NODE_ENV === "production" ? phoneRegex : sandboxPhoneRegex)
    .withMessage("phoneNumber must be a valid mobile number"),
  body("description").optional().isString().isLength({ max: 256 }),
  body("reference").optional().isString().isLength({ max: 64 }),
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "VALIDATION_ERROR", details: errors.array() });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /payments
 * Initiates a mobile money collection (debit from subscriber).
 *
 * Requires: merchant or admin role + Idempotency-Key header.
 *
 * The idempotency middleware guarantees this is safe to retry:
 * a duplicate request with the same key returns the original response
 * without re-debiting the subscriber.
 */
router.post(
  "/",
  authenticate,
  rbac("merchant", "admin"),
  idempotency,
  paymentValidation,
  validate,
  async (req, res) => {
    const { amount, currency, phoneNumber, description, reference } = req.body;

    const merchantId = req.user.merchantId || req.user.userId;

    const transaction = await initiatePayment({
      merchantId,
      amount: parseFloat(amount),
      currency,
      phoneNumber,
      description,
      reference,
    });

    res.status(202).json({
      message:
        "Payment initiated. The subscriber will receive a USSD prompt. " +
        "Poll GET /payments/:id or wait for the webhook callback for final status.",
      transaction,
    });
  }
);

/**
 * GET /payments/:transactionId
 * Poll for transaction status.
 * Merchants can only see their own transactions; admins see all.
 */
router.get(
  "/:transactionId",
  authenticate,
  rbac("merchant", "admin"),
  param("transactionId").isUUID().withMessage("transactionId must be a valid UUID"),
  validate,
  (req, res) => {
    const tx = transactions.get(req.params.transactionId);

    if (!tx) {
      return res.status(404).json({ error: "TRANSACTION_NOT_FOUND" });
    }

    // Merchants can only access their own transactions
    if (req.user.role === "merchant" && tx.merchantId !== req.user.merchantId) {
      return res.status(403).json({ error: "FORBIDDEN", message: "Transaction does not belong to your merchant account." });
    }

    res.json({ transaction: tx });
  }
);

/**
 * POST /payments/:transactionId/refund
 * Issues a full refund for a SUCCESSFUL transaction.
 * Only the owning merchant (or admin) can refund.
 */
router.post(
  "/:transactionId/refund",
  authenticate,
  rbac("merchant", "admin"),
  idempotency,
  param("transactionId").isUUID(),
  body("reason").optional().isString().isLength({ max: 256 }),
  validate,
  async (req, res) => {
    const merchantId = req.user.merchantId || req.user.userId;

    const result = await initiateRefund({
      transactionId: req.params.transactionId,
      merchantId: req.user.role === "admin" ? transactions.get(req.params.transactionId)?.merchantId : merchantId,
      reason: req.body.reason,
    });

    if (result.error) {
      const statusMap = {
        TRANSACTION_NOT_FOUND: 404,
        TRANSACTION_OWNERSHIP_MISMATCH: 403,
        REFUND_NOT_ELIGIBLE: 409,
        ALREADY_REFUNDED: 409,
      };
      return res.status(statusMap[result.error] || 400).json({ error: result.error, ...result });
    }

    res.status(202).json({
      message: "Refund initiated. Poll GET /payments/:id for status or await webhook.",
      transaction: result,
    });
  }
);

/**
 * GET /payments
 * List transactions. Merchants see only their own; admins see all.
 * Supports ?status= filter.
 */
router.get("/", authenticate, rbac("merchant", "admin"), (req, res) => {
  const { status, limit = 20, offset = 0 } = req.query;

  let all = Array.from(transactions.values());

  if (req.user.role === "merchant") {
    all = all.filter((tx) => tx.merchantId === req.user.merchantId);
  }

  if (status) {
    all = all.filter((tx) => tx.status === status.toUpperCase());
  }

  // Sort newest first
  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const paginated = all.slice(Number(offset), Number(offset) + Number(limit));

  res.json({
    total: all.length,
    limit: Number(limit),
    offset: Number(offset),
    transactions: paginated,
  });
});

module.exports = router;
