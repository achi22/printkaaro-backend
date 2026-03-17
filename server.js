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
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    const allowed = [
      "https://printkaaro.in",
      "https://www.printkaaro.in",
      "https://printkaro.vercel.app",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:4000",
    ];
    if (allowed.includes(origin) || origin.endsWith(".vercel.app")) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all for now during development
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Serve uploaded files (protected in routes, but static fallback)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ── ROUTES ── */
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);

/* ── VISIT TRACKER ── */
app.post("/api/visit", async (req, res) => {
  try {
    const { Visit } = require("./models");
    const today = new Date().toISOString().slice(0, 10);
    const vid = req.body?.vid || req.headers["x-forwarded-for"] || req.ip || "unknown";
    
    let visit = await Visit.findOne({ date: today });
    if (!visit) {
      visit = await Visit.create({ date: today, count: 1, uniqueIPs: [vid] });
    } else {
      visit.count += 1;
      if (!visit.uniqueIPs.includes(vid)) visit.uniqueIPs.push(vid);
      await visit.save();
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

app.get("/api/visits", async (req, res) => {
  try {
    const { Visit } = require("./models");
    const days = await Visit.find().sort({ date: -1 }).limit(30);
    const totalVisits = days.reduce((s, d) => s + d.count, 0);
    const totalUnique = days.reduce((s, d) => s + (d.uniqueIPs?.length || 0), 0);
    const todayStr = new Date().toISOString().slice(0, 10);
    const today = days.find(d => d.date === todayStr);
    res.json({
      totalVisits,
      totalUnique,
      todayVisits: today?.count || 0,
      todayUnique: today?.uniqueIPs?.length || 0,
      daily: days.slice(0, 7).map(d => ({ date: d.date, visits: d.count, unique: d.uniqueIPs?.length || 0 })),
    });
  } catch (e) { res.json({ totalVisits: 0, totalUnique: 0, todayVisits: 0, todayUnique: 0, daily: [] }); }
});

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
    return res.status(400).json({ error: "File too large. Maximum 200MB allowed." });
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

    // Initialize GridFS for large file storage
    const { initGridFS } = require("./models");
    initGridFS();

    // Start server
    const server = app.listen(PORT, () => {
      console.log(`✅ PrintKaaro API running on port ${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/`);

      // Keep-alive: ping self every 14 minutes to prevent Render free tier from sleeping
      const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      setInterval(() => {
        fetch(`${RENDER_URL}/`).then(() => console.log("⏰ Keep-alive ping")).catch(() => {});
      }, 14 * 60 * 1000); // Every 14 minutes
      console.log("⏰ Keep-alive enabled (every 14 min)");
    });
    server.timeout = 10 * 60 * 1000; // 10 min timeout for large uploads
    server.keepAliveTimeout = 120000;
  } catch (err) {
    console.error("❌ Failed to start:", err.message);
    process.exit(1);
  }
}

start();
