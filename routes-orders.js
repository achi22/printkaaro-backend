const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Order } = require("./models");
const { auth } = require("./middleware");

const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 9999)}`;
    cb(null, `${unique}-${file.originalname}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 52428800 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

/* ── UPLOAD PDF ── */
router.post("/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
  res.json({
    fileName: req.file.originalname,
    filePath: req.file.filename,
    fileSize: req.file.size,
  });
});

/* ── CREATE ORDER ── */
router.post("/", auth, async (req, res) => {
  try {
    const { fileName, filePath, fileSize, pages, copies, colorMode, paperSize, sided, binding, notes, price, deliveryAddress, paymentMethod } = req.body;

    if (!fileName || !pages || !copies || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Free delivery: first order OR order above ₹499
    const orderCount = await Order.countDocuments({ user: req.userId, status: { $ne: "cancelled" } });
    const isFirstOrder = orderCount === 0;
    let deliveryCharge = 40;
    if (isFirstOrder || price >= 499) deliveryCharge = 0;
    const totalPrice = price + deliveryCharge;

    const order = await Order.create({
      user: req.userId,
      fileName, filePath: filePath || "", fileSize: fileSize || 0,
      pages, copies, colorMode, paperSize, sided, binding, notes,
      price, deliveryCharge, totalPrice,
      deliveryAddress: deliveryAddress || {},
      paymentMethod: paymentMethod || "pending",
      paymentStatus: paymentMethod === "cash" ? "captured" : "pending",
      status: "confirmed",
      statusHistory: [{ status: "confirmed", note: isFirstOrder ? "First order - free delivery!" : "Order placed" }],
    });

    res.status(201).json({ order, freeDelivery: isFirstOrder || price >= 499 });

    // Send WhatsApp notification to admin (non-blocking)
    const addr = deliveryAddress || {};
    const whatsappMsg = encodeURIComponent(
      `🆕 New Order!\n\n` +
      `📋 ${order.orderId}\n` +
      `👤 ${addr.name || "Customer"} (${addr.phone || "N/A"})\n` +
      `📄 ${fileName} — ${pages}p × ${copies}c\n` +
      `🎨 ${colorMode === "bw" ? "B&W" : "Color"} | ${paperSize} | ${binding || "No Binding"}\n` +
      `💰 ₹${totalPrice} (${paymentMethod === "cash" ? "COD" : paymentMethod})\n` +
      `📍 ${addr.city || ""} - ${addr.pincode || ""}\n` +
      `${isFirstOrder ? "🎉 First order — free delivery!" : ""}`
    );
    // Log the notification URL for admin to see in logs
    console.log(`📱 WhatsApp Admin: https://wa.me/919239226708?text=${whatsappMsg}`);
  } catch (err) {
    console.error("Create order error:", err.message, err.errors ? JSON.stringify(err.errors) : "");
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/* ── TRACK ORDER (public - no auth, just orderId + phone) ── */
router.post("/track", async (req, res) => {
  try {
    const { orderId, phone } = req.body;
    if (!orderId || !phone) return res.status(400).json({ error: "Order ID and phone required" });

    const order = await Order.findOne({ orderId: orderId.trim() });
    if (!order) return res.status(404).json({ error: "Order not found. Check your order ID." });

    // Verify phone matches delivery address phone
    const orderPhone = order.deliveryAddress?.phone || "";
    if (orderPhone !== phone.trim() && !orderPhone.endsWith(phone.trim().slice(-10))) {
      return res.status(403).json({ error: "Phone number doesn't match this order" });
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── MY ORDERS ── */
router.get("/my", auth, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.userId }).sort({ createdAt: -1 });
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── GET SINGLE ORDER ── */
router.get("/:id", auth, async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [{ _id: req.params.id }, { orderId: req.params.id }],
    }).populate("user", "name phone email");

    if (!order) return res.status(404).json({ error: "Order not found" });

    // Only allow owner or admin
    if (order.user._id.toString() !== req.userId && req.userRole !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── DOWNLOAD PDF ── */
router.get("/:id/file", async (req, res) => {
  try {
    // Allow auth via header OR query token OR admin password (header or query)
    const token = req.headers.authorization?.split(" ")[1] || req.query.token;
    const adminPass = req.headers["x-admin-password"] || req.query.adminpass;
    
    if (!token && adminPass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Auth required" });
    }

    const order = await Order.findOne({
      $or: [{ _id: req.params.id }, { orderId: req.params.id }],
    });
    if (!order || !order.filePath) return res.status(404).json({ error: "File not found" });

    const filePath = path.join(uploadsDir, order.filePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found on disk" });

    res.download(filePath, order.fileName);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── CUSTOMER CANCEL ORDER (within 30 min) ── */
router.patch("/:id/cancel", auth, async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [{ _id: req.params.id }, { orderId: req.params.id }],
    });
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Check ownership
    if (order.user.toString() !== req.userId) {
      return res.status(403).json({ error: "Not your order" });
    }

    // Check if already cancelled or delivered
    if (order.status === "cancelled") return res.status(400).json({ error: "Order already cancelled" });
    if (order.status === "delivered") return res.status(400).json({ error: "Cannot cancel delivered order" });

    // Check 30 minute window
    const minutesSinceOrder = (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60);
    if (minutesSinceOrder > 30) {
      return res.status(400).json({ error: "Cancellation window expired. Orders can only be cancelled within 30 minutes." });
    }

    order.status = "cancelled";
    order.paymentStatus = order.paymentMethod === "cash" ? "cancelled" : "refunded";
    order.statusHistory.push({ status: "cancelled", note: "Cancelled by customer within 30 min" });
    await order.save();

    res.json({ order });
  } catch (err) {
    console.error("Cancel error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
