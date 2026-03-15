const jwt = require("jsonwebtoken");

/* Verify JWT token from Authorization header */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* Verify admin access - check admin password header OR JWT admin role */
function adminAuth(req, res, next) {
  // First check admin password header
  const adminPass = req.headers["x-admin-password"];
  if (adminPass && adminPass === process.env.ADMIN_PASSWORD) {
    return next();
  }

  // Otherwise check JWT for admin role
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try {
      const token = header.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = decoded.userId;
      req.userRole = decoded.role;
      if (decoded.role === "admin") return next();
    } catch (err) {}
  }

  return res.status(403).json({ error: "Admin access required" });
}

module.exports = { auth, adminAuth };
