const app = require("./src/app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║       MoMo Payment Gateway Simulation API                ║
╠══════════════════════════════════════════════════════════╣
║  Server:   http://localhost:${PORT}                         ║
║                                                          ║
║  Test credentials:                                       ║
║    Admin:    admin / admin123                            ║
║    Merchant: merchant_acme / acme123  (MERCH-001)        ║
║    Merchant: merchant_beta / beta456  (MERCH-002)        ║
╚══════════════════════════════════════════════════════════╝
  `);
});
