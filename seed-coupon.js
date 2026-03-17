/**
 * Run once to seed the FIRSTORDER coupon:
 *   node seed-coupon.js
 * 
 * Or just create it from Admin Panel → Coupons → + New Coupon
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { Coupon } = require("./models");

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  // Check if FIRSTORDER already exists
  const existing = await Coupon.findOne({ code: "FIRSTORDER" });
  if (existing) {
    console.log("FIRSTORDER coupon already exists:", existing.code, "active:", existing.active);
    await mongoose.disconnect();
    return;
  }

  const coupon = await Coupon.create({
    code: "FIRSTORDER",
    type: "firstorder",
    value: 0,
    maxDiscount: 499,
    minOrder: 0,
    description: "First order FREE up to ₹499 — limited time offer!",
    usageLimit: 100, // First 100 customers
    active: true,
    expiresAt: null, // No expiry — disable manually from admin
  });

  console.log("✅ FIRSTORDER coupon created!");
  console.log("   Code:", coupon.code);
  console.log("   Type:", coupon.type);
  console.log("   Max discount: ₹" + coupon.maxDiscount);
  console.log("   Usage limit:", coupon.usageLimit);
  
  await mongoose.disconnect();
}

seed().catch(e => { console.error("Error:", e.message); process.exit(1); });
