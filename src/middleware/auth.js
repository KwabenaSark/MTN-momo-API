const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../utils/config");

/**
 * authenticate — verifies the Bearer JWT and attaches req.user.
 * Downstream RBAC middleware then checks req.user.role.
 */
function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "MISSING_TOKEN",
      message: "Authorization header with Bearer token is required.",
    });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { userId, username, role, merchantId }
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "TOKEN_EXPIRED", message: "Token has expired." });
    }
    return res.status(401).json({ error: "INVALID_TOKEN", message: "Token is invalid." });
  }
}

module.exports = { authenticate };
