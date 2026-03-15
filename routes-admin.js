const express = require("express");
const { Order, User } = require("./models");
const { adminAuth } = require("./middleware");

const router = express.Router();

/* ── ADMIN LOGIN ── */
router.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, message: "Admin access granted" });
  } else {
    res.status(401).json({ error: "Wrong admin password" });
  }
});

/* ── DASHBOARD STATS ── */
router.get("/stats", adminAuth, async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayOrders = await Order.countDocuments({ createdAt: { $gte: today } });
    const pendingOrders = await Order.countDocuments({ status: { $in: ["confirmed", "printing", "ready"] } });
    const totalCustomers = await User.countDocuments({ role: "customer" });

    const revenueResult = await Order.aggregate([
      { $match: { status: { $ne: "cancelled" } } },
      { $group: { _id: null, total: { $sum: "$totalPrice" } } },
    ]);
    const totalRevenue = revenueResult[0]?.total || 0;

    // Revenue last 7 days
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const dailyRevenue = await Order.aggregate([
      { $match: { createdAt: { $gte: weekAgo }, status: { $ne: "cancelled" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$totalPrice" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // Status breakdown
    const statusBreakdown = await Order.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    res.json({ totalOrders, todayOrders, pendingOrders, totalCustomers, totalRevenue, dailyRevenue, statusBreakdown });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── ALL ORDERS (with filters) ── */
router.get("/orders", adminAuth, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const filter = {};

    if (status && status !== "all") filter.status = status;

    if (search) {
      filter.$or = [
        { orderId: { $regex: search, $options: "i" } },
        { fileName: { $regex: search, $options: "i" } },
        { "deliveryAddress.name": { $regex: search, $options: "i" } },
        { "deliveryAddress.phone": { $regex: search, $options: "i" } },
      ];
    }

    const orders = await Order.find(filter)
      .populate("user", "name phone email")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Order.countDocuments(filter);

    res.json({ orders, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Admin orders error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── UPDATE ORDER STATUS ── */
router.patch("/orders/:id/status", adminAuth, async (req, res) => {
  try {
    const { status, note } = req.body;
    const order = await Order.findOne({
      $or: [{ _id: req.params.id }, { orderId: req.params.id }],
    });

    if (!order) return res.status(404).json({ error: "Order not found" });

    order.status = status;
    order.statusHistory.push({ status, note: note || `Status changed to ${status}` });

    if (status === "cancelled") {
      order.paymentStatus = "refunded";
    }

    await order.save();
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── UPDATE ORDER DETAILS ── */
router.patch("/orders/:id", adminAuth, async (req, res) => {
  try {
    const updates = req.body;
    // Don't allow changing orderId or user
    delete updates.orderId;
    delete updates.user;

    const order = await Order.findOneAndUpdate(
      { $or: [{ _id: req.params.id }, { orderId: req.params.id }] },
      updates,
      { new: true }
    ).populate("user", "name phone email");

    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── ADD TRACKING ── */
router.patch("/orders/:id/tracking", adminAuth, async (req, res) => {
  try {
    const { deliveryPartner, trackingId } = req.body;
    const order = await Order.findOneAndUpdate(
      { $or: [{ _id: req.params.id }, { orderId: req.params.id }] },
      { deliveryPartner, trackingId },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── CUSTOMER LIST ── */
router.get("/customers", adminAuth, async (req, res) => {
  try {
    const customers = await User.aggregate([
      { $match: { role: "customer" } },
      {
        $lookup: {
          from: "orders", localField: "_id", foreignField: "user",
          as: "orders",
        },
      },
      {
        $project: {
          name: 1, phone: 1, email: 1, createdAt: 1,
          orderCount: { $size: "$orders" },
          totalSpent: { $sum: "$orders.totalPrice" },
        },
      },
      { $sort: { totalSpent: -1 } },
    ]);
    res.json({ customers });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── MANUAL ORDER (walk-in) ── */
router.post("/orders/manual", adminAuth, async (req, res) => {
  try {
    const data = req.body;

    // Find or create a walk-in user
    let user = await User.findOne({ phone: data.phone });
    if (!user) {
      const bcrypt = require("bcryptjs");
      user = await User.create({
        name: data.customer || "Walk-in Customer",
        phone: data.phone,
        password: await bcrypt.hash("walkin123", 10),
      });
    }

    const order = await Order.create({
      user: user._id,
      fileName: data.file || "walk-in-order.pdf",
      pages: data.pages || 1,
      copies: data.copies || 1,
      colorMode: data.colorMode || "bw",
      paperSize: data.paperSize || "A4",
      sided: data.sided || "single",
      binding: data.binding || "No Binding",
      notes: data.notes || "",
      price: data.price,
      deliveryCharge: 0,
      totalPrice: data.price,
      deliveryAddress: { name: data.customer, phone: data.phone, address: data.address || "Walk-in pickup" },
      paymentMethod: data.payment || "cash",
      paymentStatus: "captured",
      status: "confirmed",
      statusHistory: [{ status: "confirmed", note: "Manual order by admin" }],
    });

    res.status(201).json({ order });
  } catch (err) {
    console.error("Manual order error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── DELETE ORDER ── */
router.delete("/orders/:id", adminAuth, async (req, res) => {
  try {
    const order = await Order.findOneAndDelete({
      $or: [{ _id: req.params.id }, { orderId: req.params.id }],
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    
    // Also delete associated files from FileStore
    if (order.filePath) {
      const { FileStore } = require("./models");
      const fileIds = order.filePath.split(",").filter(Boolean);
      for (const fid of fileIds) {
        try { await FileStore.findByIdAndDelete(fid); } catch (e) {}
      }
    }
    
    res.json({ success: true, message: `Order ${order.orderId} deleted` });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ── BULK DELETE OLD DELIVERED ORDERS (7+ days) ── */
router.delete("/orders-cleanup", adminAuth, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    // Find old delivered/cancelled orders
    const oldOrders = await Order.find({
      status: { $in: ["delivered", "cancelled"] },
      updatedAt: { $lte: sevenDaysAgo },
    });
    
    // Delete associated files
    const { FileStore } = require("./models");
    for (const order of oldOrders) {
      if (order.filePath) {
        const fileIds = order.filePath.split(",").filter(Boolean);
        for (const fid of fileIds) {
          try { await FileStore.findByIdAndDelete(fid); } catch (e) {}
        }
      }
    }
    
    // Delete orders
    const result = await Order.deleteMany({
      status: { $in: ["delivered", "cancelled"] },
      updatedAt: { $lte: sevenDaysAgo },
    });
    
    res.json({ success: true, deleted: result.deletedCount, message: `Deleted ${result.deletedCount} old orders` });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
