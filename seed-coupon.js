require("dotenv").config();
const mongoose = require("mongoose");

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  // Define schema inline so it works even if models.js is outdated
  const couponSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ["flat", "percent", "firstorder"], default: "flat" },
    value: { type: Number, default: 0 },
    maxDiscount: { type: Number, default: 499 },
    minOrder: { type: Number, default: 0 },
    usageLimit: { type: Number, default: 0 },
    usedCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    description: { type: String, default: "" },
  }, { timestamps: true });

  const Coupon = mongoose.models.Coupon || mongoose.model("Coupon", couponSchema);

  const existing = await Coupon.findOne({ code: "FIRSTORDER" });
  if (existing) {
    console.log("FIRSTORDER already exists! Active:", existing.active, "Used:", existing.usedCount);
  } else {
    await Coupon.create({
      code: "FIRSTORDER",
      type: "firstorder",
      value: 0,
      maxDiscount: 499,
      minOrder: 0,
      description: "First order FREE up to Rs.499!",
      usageLimit: 100,
      active: true,
    });
    console.log("FIRSTORDER coupon created! Max ₹499 off, 100 uses");
  }

  await mongoose.disconnect();
  console.log("Done!");
}

seed().catch(e => { console.error("Error:", e.message); process.exit(1); });
