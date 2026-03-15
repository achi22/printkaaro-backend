const express = require("express");
const multer = require("multer");
const { Order, FileStore } = require("./models");
const { auth } = require("./middleware");

const router = express.Router();

// Multer - store in memory, then save to MongoDB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 16777216 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

/* ── UPLOAD PDF (stores in MongoDB) ── */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
  try {
    const stored = await FileStore.create({
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer.toString("base64"),
    });
    res.json({ fileName: req.file.originalname, filePath: stored._id.toString(), fileSize: req.file.size });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ── CREATE ORDER ── */
router.post("/", auth, async (req, res) => {
  try {
    const { fileName, filePath, fileSize, pages, copies, colorMode, paperSize, sided, binding, notes, price, deliveryAddress, paymentMethod } = req.body;
    if (!fileName || !pages || !copies || !price) return res.status(400).json({ error: "Missing required fields" });

    const orderCount = await Order.countDocuments({ user: req.userId, status: { $ne: "cancelled" } });
    const isFirstOrder = orderCount === 0;
    let deliveryCharge = 40;
    if (isFirstOrder || price >= 499) deliveryCharge = 0;
    const totalPrice = price + deliveryCharge;

    const order = await Order.create({
      user: req.userId, fileName, filePath: filePath || "", fileSize: fileSize || 0,
      pages, copies, colorMode, paperSize, sided, binding, notes,
      price, deliveryCharge, totalPrice, deliveryAddress: deliveryAddress || {},
      paymentMethod: paymentMethod || "pending",
      paymentStatus: paymentMethod === "cash" ? "captured" : "pending",
      status: "confirmed",
      statusHistory: [{ status: "confirmed", note: isFirstOrder ? "First order - free delivery!" : "Order placed" }],
    });

    if (filePath) {
      const fileIds = filePath.split(",").filter(Boolean);
      for (const fid of fileIds) { try { await FileStore.findByIdAndUpdate(fid, { orderId: order.orderId }); } catch (e) {} }
    }

    res.status(201).json({ order, freeDelivery: isFirstOrder || price >= 499 });

    const addr = deliveryAddress || {};
    const whatsappMsg = encodeURIComponent(`🆕 New Order!\n📋 ${order.orderId}\n👤 ${addr.name || "Customer"} (${addr.phone || "N/A"})\n📄 ${fileName}\n💰 ₹${totalPrice} (${paymentMethod === "cash" ? "COD" : paymentMethod})\n📍 ${addr.city || ""} - ${addr.pincode || ""}`);
    console.log(`📱 WhatsApp Admin: https://wa.me/918104780153?text=${whatsappMsg}`);
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/* ── TRACK ORDER (public) ── */
router.post("/track", async (req, res) => {
  try {
    const { orderId, phone } = req.body;
    if (!orderId || !phone) return res.status(400).json({ error: "Order ID and phone required" });
    const order = await Order.findOne({ orderId: orderId.trim() });
    if (!order) return res.status(404).json({ error: "Order not found" });
    const orderPhone = order.deliveryAddress?.phone || "";
    if (orderPhone !== phone.trim() && !orderPhone.endsWith(phone.trim().slice(-10))) return res.status(403).json({ error: "Phone doesn't match" });
    res.json({ order });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

/* ── MY ORDERS ── */
router.get("/my", auth, async (req, res) => {
  try { res.json({ orders: await Order.find({ user: req.userId }).sort({ createdAt: -1 }) }); }
  catch (err) { res.status(500).json({ error: "Server error" }); }
});

/* ── GET SINGLE ORDER ── */
router.get("/:id", auth, async (req, res) => {
  try {
    const order = await Order.findOne({ $or: [{ _id: req.params.id }, { orderId: req.params.id }] }).populate("user", "name phone email");
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.user._id.toString() !== req.userId && req.userRole !== "admin") return res.status(403).json({ error: "Not authorized" });
    res.json({ order });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

/* ── DOWNLOAD PDF (from MongoDB) ── */
router.get("/:id/file", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1] || req.query.token;
    const adminPass = req.headers["x-admin-password"] || req.query.adminpass;
    if (!token && adminPass !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Auth required" });

    const order = await Order.findOne({ $or: [{ _id: req.params.id }, { orderId: req.params.id }] });
    if (!order || !order.filePath) return res.status(404).json({ error: "No file linked" });

    const fileIds = order.filePath.split(",").filter(Boolean);
    if (fileIds.length === 1) {
      const stored = await FileStore.findById(fileIds[0]);
      if (!stored) return res.status(404).json({ error: "File not found in database" });
      const buffer = Buffer.from(stored.data, "base64");
      res.setHeader("Content-Type", stored.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${stored.fileName}"`);
      res.setHeader("Content-Length", buffer.length);
      return res.send(buffer);
    }
    // Multiple files - return list
    const fileList = [];
    for (const fid of fileIds) { try { const s = await FileStore.findById(fid); if (s) fileList.push({ id: s._id, name: s.fileName, size: s.size }); } catch (e) {} }
    res.json({ files: fileList, downloadBase: `/api/orders/file/` });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

/* ── DOWNLOAD SINGLE FILE BY ID ── */
router.get("/file/:fileId", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1] || req.query.token;
    const adminPass = req.headers["x-admin-password"] || req.query.adminpass;
    if (!token && adminPass !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Auth required" });
    const stored = await FileStore.findById(req.params.fileId);
    if (!stored) return res.status(404).json({ error: "File not found" });
    const buffer = Buffer.from(stored.data, "base64");
    res.setHeader("Content-Type", stored.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${stored.fileName}"`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

/* ── CANCEL ORDER (30 min) ── */
router.patch("/:id/cancel", auth, async (req, res) => {
  try {
    const order = await Order.findOne({ $or: [{ _id: req.params.id }, { orderId: req.params.id }] });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.user.toString() !== req.userId) return res.status(403).json({ error: "Not your order" });
    if (order.status === "cancelled") return res.status(400).json({ error: "Already cancelled" });
    if (order.status === "delivered") return res.status(400).json({ error: "Cannot cancel delivered order" });
    if ((Date.now() - new Date(order.createdAt).getTime()) / 60000 > 30) return res.status(400).json({ error: "Cancellation window expired (30 min)" });
    order.status = "cancelled";
    order.paymentStatus = order.paymentMethod === "cash" ? "cancelled" : "refunded";
    order.statusHistory.push({ status: "cancelled", note: "Cancelled by customer" });
    await order.save();
    res.json({ order });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

module.exports = router;
