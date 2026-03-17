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
    
    // Also delete associated files from FileStore + GridFS
    if (order.filePath) {
      const { FileStore, getGridFS } = require("./models");
      const fileIds = order.filePath.split(",").filter(Boolean);
      for (const fid of fileIds) {
        try {
          const f = await FileStore.findById(fid);
          if (f && f.gridfsId) { try { const bucket = getGridFS(); if (bucket) await bucket.delete(f.gridfsId); } catch (e) {} }
          await FileStore.findByIdAndDelete(fid);
        } catch (e) {}
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
    
    // Delete associated files + GridFS
    const { FileStore, getGridFS } = require("./models");
    for (const order of oldOrders) {
      if (order.filePath) {
        const fileIds = order.filePath.split(",").filter(Boolean);
        for (const fid of fileIds) {
          try {
            const f = await FileStore.findById(fid);
            if (f && f.gridfsId) { try { const bucket = getGridFS(); if (bucket) await bucket.delete(f.gridfsId); } catch (e) {} }
            await FileStore.findByIdAndDelete(fid);
          } catch (e) {}
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

/* ══════ SHIPROCKET INTEGRATION ══════ */
const shiprocket = require("./routes-shiprocket");

/* ── CHECK SERVICEABILITY ── */
router.post("/shiprocket/check", adminAuth, async (req, res) => {
  try {
    const { pincode, weight, cod } = req.body;
    const result = await shiprocket.checkServiceability(pincode, weight, cod);
    res.json(result);
  } catch (e) {
    console.error("Serviceability check error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── CREATE SHIPMENT ON SHIPROCKET ── */
router.post("/shiprocket/ship", adminAuth, async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findOne({ $or: [{ _id: orderId }, { orderId }] });
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Create order on Shiprocket
    const srResult = await shiprocket.createShipment(order);

    // Save Shiprocket IDs to order
    order.shiprocketOrderId = srResult.order_id;
    order.shiprocketShipmentId = srResult.shipment_id;
    order.statusHistory.push({ status: order.status, note: `Shiprocket order created: ${srResult.order_id}` });
    await order.save();

    res.json({
      success: true,
      shiprocketOrderId: srResult.order_id,
      shipmentId: srResult.shipment_id,
      status: srResult.status,
    });
  } catch (e) {
    console.error("Ship error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── GET AVAILABLE COURIERS ── */
router.post("/shiprocket/couriers", adminAuth, async (req, res) => {
  try {
    const { shipmentId } = req.body;
    const result = await shiprocket.getCouriers(shipmentId);
    
    // Parse courier list
    const couriers = (result.data?.available_courier_companies || []).map(c => ({
      id: c.courier_company_id,
      name: c.courier_name,
      rate: c.rate,
      etd: c.etd, // estimated delivery days
      rating: c.rating,
      cod: c.cod,
      minWeight: c.min_weight,
    })).sort((a, b) => a.rate - b.rate);

    res.json({ couriers, shipmentId });
  } catch (e) {
    console.error("Couriers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── ASSIGN COURIER + GENERATE AWB ── */
router.post("/shiprocket/assign", adminAuth, async (req, res) => {
  try {
    const { shipmentId, courierId, orderId } = req.body;
    
    // Assign courier
    const assignResult = await shiprocket.assignCourier(shipmentId, courierId);
    const awb = assignResult.response?.data?.awb_code || "";
    const courierName = assignResult.response?.data?.courier_name || "";

    // Generate label
    let labelUrl = "";
    try {
      const labelResult = await shiprocket.generateLabel(shipmentId);
      labelUrl = labelResult.label_url || "";
    } catch (e) { console.log("Label gen skipped:", e.message); }

    // Request pickup
    try {
      await shiprocket.requestPickup(shipmentId);
    } catch (e) { console.log("Pickup request skipped:", e.message); }

    // Update order
    const order = await Order.findOne({ $or: [{ _id: orderId }, { orderId }] });
    if (order) {
      order.status = "shipped";
      order.trackingId = awb;
      order.deliveryPartner = courierName;
      order.shiprocketAWB = awb;
      order.shiprocketLabelUrl = labelUrl;
      order.statusHistory.push({ status: "shipped", note: `Shipped via ${courierName}, AWB: ${awb}` });
      await order.save();
    }

    res.json({
      success: true,
      awb,
      courierName,
      labelUrl,
      trackingUrl: awb ? `https://shiprocket.co/tracking/${awb}` : "",
    });
  } catch (e) {
    console.error("Assign error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── TRACK SHIPMENT ── */
router.get("/shiprocket/track/:orderId", adminAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ $or: [{ _id: req.params.orderId }, { orderId: req.params.orderId }] });
    if (!order) return res.status(404).json({ error: "Order not found" });

    let tracking = null;
    if (order.shiprocketAWB) {
      tracking = await shiprocket.trackByAWB(order.shiprocketAWB);
    } else if (order.shiprocketShipmentId) {
      tracking = await shiprocket.trackShipment(order.shiprocketShipmentId);
    } else if (order.orderId) {
      tracking = await shiprocket.trackByOrderId(order.orderId);
    }

    res.json({ tracking, awb: order.shiprocketAWB, labelUrl: order.shiprocketLabelUrl });
  } catch (e) {
    console.error("Track error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── CANCEL SHIPROCKET SHIPMENT ── */
router.post("/shiprocket/cancel", adminAuth, async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findOne({ $or: [{ _id: orderId }, { orderId }] });
    if (!order || !order.shiprocketOrderId) return res.status(400).json({ error: "No Shiprocket order found" });

    await shiprocket.cancelShipment(order.shiprocketOrderId);
    order.statusHistory.push({ status: order.status, note: "Shiprocket shipment cancelled" });
    order.shiprocketAWB = "";
    order.trackingId = "";
    order.deliveryPartner = "";
    await order.save();

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── PUBLIC TRACKING (for customers) ── */
router.get("/shiprocket/public-track/:awb", async (req, res) => {
  try {
    const result = await shiprocket.trackByAWB(req.params.awb);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "Tracking unavailable" });
  }
});

module.exports = router;
