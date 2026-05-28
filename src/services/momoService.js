const { v4: uuidv4 } = require("uuid");
const { PROVIDER_SIM_DELAY_MS, APPROVAL_RATE } = require("../utils/config");
const { transactions } = require("../store");
const { scheduleWebhookDelivery } = require("./webhookService");
require('dotenv').config();

/**
 * Simulates the async two-phase pattern used by MTN MoMo and Vodafone Cash:
 *
 * Phase 1 — Initiate:  POST /payments → returns transactionId + "PENDING"
 * Phase 2 — Callback:  Provider POSTs to merchant webhook with final status
 */

async function initiatePayment({ merchantId, amount, currency, phoneNumber, description, reference }) {
  const transactionId = uuidv4();

  const transaction = {
    transactionId,
    merchantId,
    amount,
    currency: currency || "GHS",
    phoneNumber,
    description: description || "",
    externalReference: reference || null,
    status: "PENDING",
    provider: detectProvider(phoneNumber),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settledAt: null,
    failureReason: null,
  };

  transactions.set(transactionId, transaction);

  // Switch between live integration and mock simulator based on provider
  if (transaction.provider === "MTN_MOMO") {
    // Fire and forget asynchronously so the client gets an immediate 202 response
    callMtnMomoApi(transaction).catch((err) => {
      console.error("[MTN BRIDGE ERROR] API Call Failed:", err.message);
    });
  } else {
    // Fall back to simulator for Vodafone / AirtelTigo for now
    simulateProviderCallback(transactionId);
  }

  return transaction;
}

async function initiateRefund({ transactionId, merchantId, reason }) {
  const original = transactions.get(transactionId);

  if (!original) {
    return { error: "TRANSACTION_NOT_FOUND" };
  }

  if (original.merchantId !== merchantId) {
    return { error: "TRANSACTION_OWNERSHIP_MISMATCH" };
  }

  if (original.status !== "SUCCESSFUL") {
    return { error: "REFUND_NOT_ELIGIBLE", currentStatus: original.status };
  }

  if (original.refundedAt) {
    return { error: "ALREADY_REFUNDED" };
  }

  const refundId = uuidv4();
  const refund = {
    transactionId: refundId,
    merchantId,
    amount: original.amount,
    currency: original.currency,
    phoneNumber: original.phoneNumber,
    description: `Refund for ${transactionId}: ${reason || "requested by merchant"}`,
    externalReference: `REFUND-${transactionId}`,
    status: "PENDING",
    provider: original.provider,
    type: "REFUND",
    originalTransactionId: transactionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settledAt: null,
    failureReason: null,
  };

  transactions.set(refundId, refund);
  original.refundedAt = new Date().toISOString();
  original.refundTransactionId = refundId;

  simulateProviderCallback(refundId);

  return refund;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectProvider(phoneNumber) {
  const cleaned = phoneNumber.replace(/\D/g, "");

  if (/^(024|054|055|059)/.test(cleaned) || /^(23324|23354|23355|23359)/.test(cleaned)) {
    return "MTN_MOMO";
  }
  if (/^(020|050)/.test(cleaned) || /^(23320|23350)/.test(cleaned)) {
    return "VODAFONE_CASH";
  }
  if (/^(026|056|027|057)/.test(cleaned)) {
    return "AIRTELTIGO_MONEY";
  }
  return "MTN_MOMO";
}

function simulateProviderCallback(transactionId) {
  setTimeout(async () => {
    const tx = transactions.get(transactionId);
    if (!tx) return;

    const approved = Math.random() < APPROVAL_RATE;

    tx.status = approved ? "SUCCESSFUL" : "FAILED";
    tx.updatedAt = new Date().toISOString();

    if (approved) {
      tx.settledAt = new Date().toISOString();
      tx.providerReference = `${tx.provider}-${uuidv4().slice(0, 8).toUpperCase()}`;
    } else {
      tx.failureReason = pickFailureReason();
    }

    await scheduleWebhookDelivery(tx);
  }, PROVIDER_SIM_DELAY_MS);
}

async function callMtnMomoApi(transaction) {
  console.log(`[MTN BRIDGE] Fetching OAuth token...`);

  const authHeader = Buffer.from(`${process.env.MTN_API_USER}:${process.env.MTN_API_KEY}`).toString("base64");

  const tokenRes = await fetch(`${process.env.MTN_BASE_URL}/collection/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Ocp-Apim-Subscription-Key": process.env.MTN_SUBSCRIPTION_KEY,
    },
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Auth failed with status ${tokenRes.status}: ${errText}`);
  }

  const { access_token } = await tokenRes.json();
  console.log(`[MTN BRIDGE] OAuth token retrieved successfully.`);

  const momoRes = await fetch(`${process.env.MTN_BASE_URL}/collection/v1_0/requesttopay`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "X-Reference-Id": transaction.transactionId,
      "X-Target-Environment": "sandbox",
      "Ocp-Apim-Subscription-Key": process.env.MTN_SUBSCRIPTION_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: String(transaction.amount),
      currency: process.env.MTN_CURRENCY || "EUR",
      externalId: transaction.externalReference || transaction.transactionId,
      payer: { partyIdType: "MSISDN", partyId: transaction.phoneNumber },
      payerMessage: transaction.description || "Payment Request",
      payeeNote: transaction.description || "Payment Request",
    }),
  });

  console.log(`[MTN BRIDGE] Live Sandbox Gateway returned response code: ${momoRes.status}`);

  if (!momoRes.ok) {
    const errBody = await momoRes.text();
    console.error(`[MTN BRIDGE] RequestToPay rejected: ${errBody}`);
    return; // ← stop here, don't fall through
  }

  // ── Poll MTN for final status ─────────────────────────────────
  console.log(`[MTN BRIDGE] Waiting 5s before polling for final status...`);
  await new Promise((r) => setTimeout(r, 5000));

  const statusRes = await fetch(
    `${process.env.MTN_BASE_URL}/collection/v1_0/requesttopay/${transaction.transactionId}`,
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Target-Environment": "sandbox",
        "Ocp-Apim-Subscription-Key": process.env.MTN_SUBSCRIPTION_KEY,
      },
    }
  );

  const mtnPayload = await statusRes.json(); // ← now defined
  console.log(`[MTN BRIDGE] 202 confirmed, entering poll...`); 
  console.log(`[MTN BRIDGE] Final status from MTN:`, JSON.stringify(mtnPayload, null, 2));

  // ── Update local transaction + fire webhook ───────────────────
  const tx = require("../store").transactions.get(transaction.transactionId);
  if (tx) {
    tx.status = mtnPayload.status === "SUCCESSFUL" ? "SUCCESSFUL" : "FAILED";
    tx.updatedAt = new Date().toISOString();
    tx.providerReference = mtnPayload.financialTransactionId || null;
    tx.failureReason = mtnPayload.reason?.code || null;
    await scheduleWebhookDelivery(tx);
  }
}

function pickFailureReason() {
  const reasons = [
    "INSUFFICIENT_FUNDS",
    "SUBSCRIBER_NOT_FOUND",
    "SUBSCRIBER_NOT_REGISTERED_FOR_MOBILE_MONEY",
    "TRANSACTION_LIMIT_EXCEEDED",
    "PROVIDER_TIMEOUT",
  ];
  return reasons[Math.floor(Math.random() < reasons.length)];
}



module.exports = { initiatePayment, initiateRefund };