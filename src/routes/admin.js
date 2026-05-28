const express = require("express");
const { authenticate } = require("../middleware/auth");
const { rbac } = require("../middleware/rbac");
const { transactions, webhooks, webhookDeliveries, users } = require("../store");

const router = express.Router();

/**
 * Admin-only routes — restricted by rbac('admin').
 * Demonstrates that the same RBAC middleware cleanly separates
 * merchant-level and platform-level access.
 */

// GET /admin/transactions — all transactions across all merchants
router.get("/transactions", authenticate, rbac("admin"), (req, res) => {
  const { status, merchantId } = req.query;
  let all = Array.from(transactions.values());

  if (status) all = all.filter((tx) => tx.status === status.toUpperCase());
  if (merchantId) all = all.filter((tx) => tx.merchantId === merchantId);

  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ total: all.length, transactions: all });
});

// GET /admin/metrics — simple aggregate stats
router.get("/metrics", authenticate, rbac("admin"), (req, res) => {
  const all = Array.from(transactions.values());

  const byStatus = all.reduce((acc, tx) => {
    acc[tx.status] = (acc[tx.status] || 0) + 1;
    return acc;
  }, {});

  const byProvider = all.reduce((acc, tx) => {
    acc[tx.provider] = (acc[tx.provider] || 0) + 1;
    return acc;
  }, {});

  const successfulVolume = all
    .filter((tx) => tx.status === "SUCCESSFUL")
    .reduce((sum, tx) => sum + tx.amount, 0);

  const approvalRate =
    all.length > 0
      ? ((byStatus.SUCCESSFUL || 0) / all.filter((tx) => tx.status !== "PENDING").length || 0).toFixed(4)
      : null;

  res.json({
    totalTransactions: all.length,
    byStatus,
    byProvider,
    successfulVolumeCurrency: "GHS",
    successfulVolume: parseFloat(successfulVolume.toFixed(2)),
    approvalRate: approvalRate ? parseFloat(approvalRate) : null,
    webhookDeliveries: {
      total: webhookDeliveries.length,
      delivered: webhookDeliveries.filter((d) => d.outcome === "DELIVERED").length,
      failed: webhookDeliveries.filter((d) => d.outcome === "EXHAUSTED").length,
    },
  });
});

// GET /admin/merchants — list registered merchants
router.get("/merchants", authenticate, rbac("admin"), (req, res) => {
  const merchants = users
    .filter((u) => u.role === "merchant")
    .map((u) => ({
      merchantId: u.merchantId,
      username: u.username,
      webhookRegistered: webhooks.has(u.merchantId),
    }));

  res.json({ merchants });
});

module.exports = router;
