const express = require("express");

const authRoutes = require("./routes/auth");
const paymentRoutes = require("./routes/payments");
const webhookRoutes = require("./routes/webhooks");
const adminRoutes = require("./routes/admin");

const app = express();

app.use(express.json());

// ─── Request ID middleware (useful for log correlation) ───────────────────────
app.use((req, res, next) => {
  req.requestId = require("uuid").v4();
  res.set("X-Request-Id", req.requestId);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/auth", authRoutes);
app.use("/payments", paymentRoutes);
app.use("/webhooks", webhookRoutes);
app.use("/admin", adminRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND", path: req.path });
});

// ─── Global error handler ────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${req.requestId}] Unhandled error:`, err);
  res.status(500).json({
    error: "INTERNAL_SERVER_ERROR",
    requestId: req.requestId,
  });
});

module.exports = app;
