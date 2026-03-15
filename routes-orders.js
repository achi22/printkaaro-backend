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
    const { fileName, filePath, fileSize, pages, copies, colorMode, paperSize, sided, binding, notes, price, deliveryCharge, totalPrice, deliveryAddress, paymentMethod } = req.body;

    if (!fileName || !pages || !copies || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const order = await Order.create({
      user: req.userId,
      fileName, filePath: filePath || "", fileSize: fileSize || 0,
      pages, copies, colorMode, paperSize, sided, binding, notes,
      price, deliveryCharge: deliveryCharge || 0, totalPrice: totalPrice || price,
      deliveryAddress: deliveryAddress || {},
      paymentMethod: paymentMethod || "pending",
      paymentStatus: paymentMethod === "cash" ? "captured" : "pending",
      status: "confirmed",
      statusHistory: [{ status: "confirmed", note: "Order placed" }],
    });

    res.status(201).json({ order });
  } catch (err) {
    console.error("Create order error:", err.message, err.errors ? JSON.stringify(err.errors) : "");
    res.status(500).json({ error: err.message || "Server error" });
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
router.get("/:id/file", auth, async (req, res) => {
  try {
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

module.exports = router;
