/**
 * RBAC — Role-Based Access Control middleware factory.
 *
 * Usage:
 *   router.get('/admin/all', authenticate, rbac('admin'), handler)
 *   router.post('/payments', authenticate, rbac('merchant', 'admin'), handler)
 *
 * Design note: roles is variadic so one middleware call can allow
 * multiple roles, keeping route definitions readable.
 */
function rbac(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      // Should not reach here if authenticate ran first, but guard anyway
      return res.status(401).json({ error: "UNAUTHENTICATED" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: `Role '${req.user.role}' is not permitted to access this resource.`,
      });
    }

    next();
  };
}

module.exports = { rbac };
