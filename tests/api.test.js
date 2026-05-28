require('dotenv').config(); // Load environment variables first

const request = require("supertest");
const app = require("../src/app");

// ─── Network Mocks Commented Out for Live Sandbox Integration ─────────────────
// const nock = require('nock');
// beforeAll(() => {
//   // Mock MTN OAuth token endpoint
//   nock('https://sandbox.momodeveloper.mtn.com')
//     .post('/collection/token/')
//     .reply(200, { access_token: 'fake-token', token_type: 'Bearer' });
//
//   // Mock MTN requesttopay endpoint
//   nock('https://sandbox.momodeveloper.mtn.com')
//     .post('/collection/v1_0/requesttopay')
//     .reply(202);
// });

// ─── Helper ───────────────────────────────────────────────────────────────────
async function login(username, password) {
  const res = await request(app).post("/auth/login").send({ username, password });
  return res.body.token;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
describe("POST /auth/login", () => {
  it("returns a JWT for valid credentials", async () => {
    const res = await request(app).post("/auth/login").send({ username: "merchant_acme", password: "acme123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe("merchant");
  });

  it("returns 401 for wrong password", async () => {
    const res = await request(app).post("/auth/login").send({ username: "merchant_acme", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("INVALID_CREDENTIALS");
  });

  it("returns 400 when username is missing", async () => {
    const res = await request(app).post("/auth/login").send({ password: "acme123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });
});

// ─── RBAC ─────────────────────────────────────────────────────────────────────
describe("RBAC enforcement", () => {
  it("returns 401 when no token provided", async () => {
    const res = await request(app).get("/payments");
    expect(res.status).toBe(401);
  });

  it("denies merchant access to admin endpoints", async () => {
    const token = await login("merchant_acme", "acme123");
    const res = await request(app).get("/admin/metrics").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN");
  });

  it("allows admin access to admin endpoints", async () => {
    const token = await login("admin", "admin123");
    const res = await request(app).get("/admin/metrics").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// ─── Payments ────────────────────────────────────────────────────────────────
describe("POST /payments", () => {
  let token;
  beforeAll(async () => { token = await login("merchant_acme", "acme123"); });

  it("requires Idempotency-Key header", async () => {
    const res = await request(app)
      .post("/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 10, phoneNumber: "46733123453" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("initiates a payment and returns PENDING status", async () => {
    const res = await request(app)
      .post("/payments")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-idem-001")
      .send({ amount: 50, phoneNumber: "46733123453", description: "Test payment" });
    expect(res.status).toBe(202);
    expect(res.body.transaction.status).toBe("PENDING");
    expect(res.body.transaction.provider).toBe("MTN_MOMO");
  });

  it("rejects invalid phone number", async () => {
    const res = await request(app)
      .post("/payments")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-idem-002")
      .send({ amount: 10, phoneNumber: "12345" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects zero amount", async () => {
    const res = await request(app)
      .post("/payments")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "test-idem-003")
      .send({ amount: 0, phoneNumber: "46733123453" });
    expect(res.status).toBe(400);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────
describe("Idempotency", () => {
  let token;
  const idemKey = `idem-dedup-${Date.now()}`;

  beforeAll(async () => { token = await login("merchant_acme", "acme123"); });

  it("returns the same response on duplicate request", async () => {
    const payload = { amount: 25, phoneNumber: "46733123453", description: "Idempotency test" };

    const first = await request(app)
      .post("/payments")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey)
      .send(payload);

    // Small wait to let in-flight state settle
    await new Promise((r) => setTimeout(r, 50));

    const second = await request(app)
      .post("/payments")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey)
      .send(payload);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    // Same transaction ID — no double-charge
    expect(first.body.transaction.transactionId).toBe(second.body.transaction.transactionId);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
  });
});

// ─── Transaction ownership ───────────────────────────────────────────────────
describe("Merchant transaction isolation", () => {
  it("prevents merchant from seeing another merchant's transaction", async () => {
    const acmeToken = await login("merchant_acme", "acme123");
    const betaToken = await login("merchant_beta", "beta456");

    // Acme creates a transaction
    const createRes = await request(app)
      .post("/payments")
      .set("Authorization", `Bearer ${acmeToken}`)
      .set("Idempotency-Key", `isolation-${Date.now()}`)
      .send({ amount: 10, phoneNumber: "46733123453" });

    const txId = createRes.body.transaction.transactionId;

    // Beta tries to read it
    const readRes = await request(app)
      .get(`/payments/${txId}`)
      .set("Authorization", `Bearer ${betaToken}`);

    expect(readRes.status).toBe(403);
  });
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────
describe("POST /webhooks/register", () => {
  let token;
  beforeAll(async () => { token = await login("merchant_acme", "acme123"); });

  it("registers a webhook and returns a signing secret", async () => {
    const res = await request(app)
      .post("/webhooks/register")
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://example.com/webhook", events: ["payment.success"] });
    expect(res.status).toBe(201);
    expect(res.body.webhook.signingSecret).toBeDefined();
    expect(res.body.webhook.signingSecret.length).toBe(32);
  });

  it("rejects invalid URLs", async () => {
    const res = await request(app)
      .post("/webhooks/register")
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "not-a-url" });
    expect(res.status).toBe(400);
  });
});