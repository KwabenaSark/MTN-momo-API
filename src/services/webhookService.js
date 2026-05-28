const crypto = require("crypto");
const { webhooks, webhookDeliveries } = require("../store");
const { WEBHOOK_RETRY_DELAYS_MS } = require("../utils/config");

async function scheduleWebhookDelivery(transaction) {
  const webhook = webhooks.get(transaction.merchantId);
  if (!webhook) return;

  const event = buildEvent(transaction);
  attemptDelivery(webhook, event, transaction.merchantId, 0);
}

function buildEvent(transaction) {
  return {
    eventId: require("uuid").v4(),
    eventType: transaction.status === "SUCCESSFUL" ? "payment.success" : "payment.failed",
    createdAt: new Date().toISOString(),
    data: { ...transaction },
  };
}

function attemptDelivery(webhook, event, merchantId, attemptIndex) {
  const delay = WEBHOOK_RETRY_DELAYS_MS[attemptIndex] ?? null;

  if (delay === null) {
    logDelivery(merchantId, event, attemptIndex, null, "EXHAUSTED");
    return;
  }

  setTimeout(async () => {
    const payload = JSON.stringify(event);
    const signature = sign(payload, webhook.signingSecret);

    let responseStatus = null;
    let outcome = "FAILED";

    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Event": event.eventType,
          "X-Webhook-Delivery": event.eventId,
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });

      responseStatus = res.status;

      if (res.ok) {
        outcome = "DELIVERED";
      } else {
        console.warn(`[WEBHOOK] Merchant endpoint returned ${res.status} for event ${event.eventId}`);
        throw new Error(`Non-2xx response: ${res.status}`);
      }
    } catch (err) {
      console.error(`[WEBHOOK] Delivery attempt ${attemptIndex + 1} failed: ${err.message}`);
      outcome = attemptIndex + 1 < WEBHOOK_RETRY_DELAYS_MS.length ? "RETRYING" : "EXHAUSTED";
    }

    logDelivery(merchantId, event, attemptIndex + 1, responseStatus, outcome);

    if (outcome === "RETRYING") {
      attemptDelivery(webhook, event, merchantId, attemptIndex + 1);
    }
  }, delay);
}

function sign(payload, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function logDelivery(merchantId, event, attemptNumber, httpStatus, outcome) {
  webhookDeliveries.push({
    merchantId,
    eventId: event.eventId,
    eventType: event.eventType,
    transactionId: event.data.transactionId,
    attemptNumber,
    httpStatus,
    outcome,
    timestamp: new Date().toISOString(),
  });
}


module.exports = { scheduleWebhookDelivery };