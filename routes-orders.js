const express = require("express");
const multer = require("multer");
const { Readable } = require("stream");
const mongoose = require("mongoose");
const { Order, FileStore, getGridFS } = require("./models");
const { auth } = require("./middleware");

const router = express.Router();

// Multer for small files (< 8MB) — memory is fine
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/heic"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF and image files (JPG, PNG, GIF, WebP) are allowed"));
  },
});

// Multer for chunks — each chunk max 10MB
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* ══════════════════════════════════════════════
   UPLOAD SMALL FILE (< 8MB from frontend)
   Stored as base64 in MongoDB document
   ══════════════════════════════════════════════ */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const sizeMB = (req.file.size / (1024 * 1024)).toFixed(1);
    console.log(`📁 Small upload: ${req.file.originalname} (${sizeMB}MB)`);
    const stored = await FileStore.create({
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer.toString("base64"),
    });
    console.log(`✅ Stored: ${stored._id}`);
    res.json({ fileName: req.file.originalname, filePath: stored._id.toString(), fileSize: req.file.size });
  } catch (err) {
    console.error("❌ Upload error:", err.message);
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

/* ══════════════════════════════════════════════
   CHUNKED UPLOAD — STREAM-TO-GRIDFS DESIGN
   
   Each chunk is written to GridFS immediately.
   Only a tiny tracker object stays in memory.
   Can handle 100+ simultaneous large uploads.
   
   Flow:
   1. Chunk 0 arrives → open GridFS stream, write, save stream ref
   2. Chunks 1..N-2 arrive → write to existing stream  
   3. Last chunk arrives → write, close stream, create FileStore record
   ══════════════════════════════════════════════ */

// Track active uploads — only stores GridFS stream ref + metadata (no file data!)
// Memory per upload: ~500 bytes (vs 100MB+ in old design)
const activeUploads = new Map();

// Clean up stale uploads (abandoned after 15 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of activeUploads) {
    if (now - u.startTime > 15 * 60 * 1000) {
      console.log(`🧹 Cleaning stale upload: ${id}`);
      try { if (u.stream) u.stream.abort(); } catch (e) {}
      activeUploads.delete(id);
    }
  }
}, 60 * 1000);

router.post("/upload-chunk", auth, chunkUpload.single("chunk"), async (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, fileName, mimeType, fileSize } = req.body;
    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      return res.status(400).json({ error: "Missing chunk info" });
    }

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);
    const size = parseInt(fileSize) || 0;

    // ── First chunk: open GridFS write stream ──
    if (idx === 0) {
      const bucket = getGridFS();
      if (!bucket) return res.status(500).json({ error: "Storage not ready, try again in a moment" });

      const uploadStream = bucket.openUploadStream(fileName, { contentType: mimeType || "application/pdf" });
      
      activeUploads.set(uploadId, {
        stream: uploadStream,
        fileName: fileName,
        mimeType: mimeType || "application/pdf",
        fileSize: size,
        received: 0,
        total: total,
        startTime: Date.now(),
      });

      console.log(`📦 Started chunked upload: ${fileName} (${total} chunks, ~${(size / (1024 * 1024)).toFixed(0)}MB)`);
    }

    const upload = activeUploads.get(uploadId);
    if (!upload) {
      return res.status(400).json({ error: "Upload session not found. Please retry." });
    }

    // ── Write this chunk directly to GridFS (no memory accumulation!) ──
    const written = upload.stream.write(req.file.buffer);
    upload.received++;

    console.log(`  📦 Chunk ${idx + 1}/${total} written (${(req.file.size / 1024).toFixed(0)}KB)`);

    // ── Not done yet ──
    if (upload.received < total) {
      return res.json({ ok: true, received: upload.received, total });
    }

    // ── Last chunk: close stream, create FileStore record ──
    console.log(`✅ All ${total} chunks received for ${upload.fileName}, finalizing...`);

    await new Promise((resolve, reject) => {
      upload.stream.end(() => resolve());
      upload.stream.on("error", reject);
    });

    const gridfsId = upload.stream.id;

    const stored = await FileStore.create({
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.fileSize,
      data: "",
      gridfsId: gridfsId,
    });

    activeUploads.delete(uploadId);

    console.log(`✅ Large file complete: ${stored._id} (GridFS: ${gridfsId}, ${(upload.fileSize / (1024 * 1024)).toFixed(1)}MB)`);
    res.json({ fileName: upload.fileName, filePath: stored._id.toString(), fileSize: upload.fileSize });

  } catch (err) {
    console.error("❌ Chunk error:", err.message);
    // Clean up on error
    try {
      const u = activeUploads.get(req.body?.uploadId);
      if (u && u.stream) u.stream.abort();
      activeUploads.delete(req.body?.uploadId);
    } catch (e) {}
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

/* ══════════════════════════════════════════════
   CREATE ORDER
   ══════════════════════════════════════════════ */
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

/* ── Helper: stream file to response ── */
async function streamFile(stored, res) {
  if (stored.gridfsId) {
    const bucket = getGridFS();
    if (!bucket) return res.status(500).json({ error: "Storage not ready" });
    res.setHeader("Content-Type", stored.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${stored.fileName}"`);
    if (stored.size) res.setHeader("Content-Length", stored.size);
    const downloadStream = bucket.openDownloadStream(stored.gridfsId);
    downloadStream.pipe(res);
    downloadStream.on("error", () => res.status(500).end());
  } else {
    const buffer = Buffer.from(stored.data, "base64");
    res.setHeader("Content-Type", stored.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${stored.fileName}"`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  }
}

/* ── DOWNLOAD FILE BY ORDER ── */
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
      return streamFile(stored, res);
    }
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
    return streamFile(stored, res);
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
