const express = require("express");
const jwt = require("jsonwebtoken");
const { users } = require("../store");
const { JWT_SECRET, JWT_EXPIRES_IN } = require("../utils/config");
const { body, validationResult } = require("express-validator");

const router = express.Router();

/**
 * POST /auth/login
 * Returns a signed JWT. Role is embedded in the token so RBAC
 * middleware can enforce it without a DB lookup on every request.
 */
router.post(
  "/login",
  [
    body("username").trim().notEmpty().withMessage("username is required"),
    body("password").notEmpty().withMessage("password is required"),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "VALIDATION_ERROR", details: errors.array() });
    }

    const { username, password } = req.body;
    const user = users.find((u) => u.username === username && u.password === password);

    if (!user) {
      return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Username or password is incorrect." });
    }

    const payload = {
      userId: user.id,
      username: user.username,
      role: user.role,
      merchantId: user.merchantId,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.json({
      token,
      expiresIn: JWT_EXPIRES_IN,
      user: { username: user.username, role: user.role, merchantId: user.merchantId },
    });
  }
);

/**
 * GET /auth/me — returns the decoded token payload (identity check)
 */
const { authenticate } = require("../middleware/auth");
router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
