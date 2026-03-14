require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes-auth");
const orderRoutes = require("./routes-orders");
const adminRoutes = require("./routes-admin");

const app = express();

/* ── MIDDLEWARE ── */
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "https://printkaaro.in",
    "http://localhost:3000",
    "http://localhost:5173",
  ],
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// Serve uploaded files (protected in routes, but static fallback)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ── ROUTES ── */
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);

/* ── HEALTH CHECK ── */
app.get("/", (req, res) => {
  res.json({
    name: "PrintKaaro API",
    status: "running",
    version: "1.0.0",
    endpoints: {
      auth: "/api/auth (signup, signin, me)",
      orders: "/api/orders (create, list, upload)",
      admin: "/api/admin (stats, orders, customers)",
    },
  });
});

/* ── ERROR HANDLER ── */
app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File too large. Maximum 50MB allowed." });
  }
  res.status(500).json({ error: err.message || "Internal server error" });
});

/* ── START SERVER ── */
const PORT = process.env.PORT || 4000;

async function start() {
  try {
    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connected!");

    // Start server
    app.listen(PORT, () => {
      console.log(`✅ PrintKaaro API running on port ${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/`);
      console.log(`   Auth:   http://localhost:${PORT}/api/auth`);
      console.log(`   Orders: http://localhost:${PORT}/api/orders`);
      console.log(`   Admin:  http://localhost:${PORT}/api/admin`);
    });
  } catch (err) {
    console.error("❌ Failed to start:", err.message);
    process.exit(1);
  }
}

start();
