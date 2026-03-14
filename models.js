const mongoose = require("mongoose");

/* ══════ USER ══════ */
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true, index: true },
  email: { type: String, trim: true, default: "" },
  password: { type: String, required: true },
  addresses: [{
    label: { type: String, default: "Home" },
    name: String,
    phone: String,
    address: String,
    city: String,
    pincode: String,
    state: { type: String, default: "West Bengal" },
  }],
  role: { type: String, enum: ["customer", "admin"], default: "customer" },
}, { timestamps: true });

/* ══════ ORDER ══════ */
const orderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  // File info
  fileName: { type: String, required: true },
  filePath: { type: String, default: "" },
  fileSize: { type: Number, default: 0 },

  // Print specs
  pages: { type: Number, required: true, min: 1 },
  copies: { type: Number, required: true, min: 1 },
  colorMode: { type: String, enum: ["bw", "color", "booklet"], default: "bw" },
  paperSize: { type: String, enum: ["A4", "A3", "A5", "Legal"], default: "A4" },
  sided: { type: String, enum: ["single", "double"], default: "single" },
  binding: { type: String, default: "No Binding" },
  notes: { type: String, default: "" },

  // Pricing
  price: { type: Number, required: true },
  deliveryCharge: { type: Number, default: 0 },
  totalPrice: { type: Number, required: true },

  // Delivery
  deliveryAddress: {
    name: String,
    phone: String,
    address: String,
    city: String,
    pincode: String,
    state: { type: String, default: "West Bengal" },
  },
  deliveryPartner: { type: String, default: "" },
  trackingId: { type: String, default: "" },

  // Payment
  paymentMethod: { type: String, enum: ["upi", "razorpay", "cash", "pending"], default: "pending" },
  paymentStatus: { type: String, enum: ["pending", "captured", "failed", "refunded"], default: "pending" },
  razorpayOrderId: { type: String, default: "" },
  razorpayPaymentId: { type: String, default: "" },

  // Status
  status: {
    type: String,
    enum: ["pending", "confirmed", "printing", "ready", "shipped", "delivered", "cancelled"],
    default: "pending",
    index: true,
  },
  statusHistory: [{
    status: String,
    timestamp: { type: Date, default: Date.now },
    note: { type: String, default: "" },
  }],

}, { timestamps: true });

// Generate orderId before saving
orderSchema.pre("save", function (next) {
  if (!this.orderId) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rand = String(Math.floor(Math.random() * 9999)).padStart(4, "0");
    this.orderId = `PK-${date}-${rand}`;
  }
  next();
});

const User = mongoose.model("User", userSchema);
const Order = mongoose.model("Order", orderSchema);

module.exports = { User, Order };
