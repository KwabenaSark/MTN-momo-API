/**
 * In-memory store — replaces a DB for demo purposes.
 * In production this would be Redis (idempotency keys) + Postgres (transactions).
 */

const { v4: uuidv4 } = require("uuid");

// ─── Seed Users ────────────────────────────────────────────────────────────────
// Passwords are plaintext here for demo clarity.
// In prod: bcrypt hashes, stored in DB.
const users = [
  {
    id: uuidv4(),
    username: "admin",
    password: "admin123",
    role: "admin",
    merchantId: null,
  },
  {
    id: uuidv4(),
    username: "merchant_acme",
    password: "acme123",
    role: "merchant",
    merchantId: "MERCH-001",
  },
  {
    id: uuidv4(),
    username: "merchant_beta",
    password: "beta456",
    role: "merchant",
    merchantId: "MERCH-002",
  },
];

// ─── Transactions ──────────────────────────────────────────────────────────────
// Map of transactionId → transaction object
const transactions = new Map();

// ─── Idempotency Keys ──────────────────────────────────────────────────────────
// Map of idempotencyKey → transactionId
// Expires after TTL (24h in prod; we store createdAt for demo inspection)
const idempotencyKeys = new Map();

// ─── Webhook Registrations ────────────────────────────────────────────────────
// Map of merchantId → { url, secret, events[] }
const webhooks = new Map();

// ─── Webhook Delivery Log ─────────────────────────────────────────────────────
// Array of delivery attempt records (for admin visibility)
const webhookDeliveries = [];

module.exports = {
  users,
  transactions,
  idempotencyKeys,
  webhooks,
  webhookDeliveries,
};
