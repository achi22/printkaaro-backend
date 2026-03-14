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

/* Verify admin access */
function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.userRole !== "admin") {
      // Also allow admin password in header
      const adminPass = req.headers["x-admin-password"];
      if (adminPass !== process.env.ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Admin access required" });
      }
    }
    next();
  });
}

module.exports = { auth, adminAuth };
