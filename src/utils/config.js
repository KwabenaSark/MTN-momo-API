module.exports = {
  JWT_SECRET: process.env.JWT_SECRET || "momo-demo-secret-change-in-prod",
  JWT_EXPIRES_IN: "8h",

  // Simulated MoMo provider response delays (ms)
  PROVIDER_SIM_DELAY_MS: parseInt(process.env.PROVIDER_SIM_DELAY_MS || "300", 10),

  // Webhook retry schedule (delays in ms between attempts)
  // Production MTN MoMo uses exponential backoff; we mirror that pattern.
  WEBHOOK_RETRY_DELAYS_MS: [0, 5000, 30000, 300000], // immediate, 5s, 30s, 5min

  // Simulated approval rate (to demo partial failures realistically)
  APPROVAL_RATE: parseFloat(process.env.APPROVAL_RATE || "0.85"),
};
