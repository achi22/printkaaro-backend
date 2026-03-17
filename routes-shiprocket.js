/**
 * Shiprocket API Integration for PrintKaaro
 * Handles: Auth, Create Order, Track Shipment, Cancel
 */

const SHIPROCKET_BASE = "https://apiv2.shiprocket.in/v1/external";
let srToken = null;
let srTokenExpiry = 0;

// ── GET AUTH TOKEN (auto-refresh) ──
async function getToken() {
  if (srToken && Date.now() < srTokenExpiry) return srToken;

  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) throw new Error("Shiprocket credentials not configured");

  const res = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(data.message || "Shiprocket auth failed");

  srToken = data.token;
  srTokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000; // 9 days (token valid 10 days)
  console.log("✅ Shiprocket token refreshed");
  return srToken;
}

// ── HELPER: API call ──
async function srAPI(endpoint, method = "GET", body = null) {
  const token = await getToken();
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${SHIPROCKET_BASE}${endpoint}`, opts);
  const data = await res.json();

  if (!res.ok) {
    console.error("❌ Shiprocket API error:", JSON.stringify(data));
    throw new Error(data.message || data.errors?.[0] || "Shiprocket API error");
  }
  return data;
}

// ── PICKUP ADDRESS (your warehouse) ──
const PICKUP_ADDRESS = {
  pickup_location: "PrintKaaro Warehouse",
  name: "Debayan Saha",
  email: "achintyamandal606@gmail.com",
  phone: "8104780153",
  address: "House 0007, Near Nazirpur Bus Stand",
  address_2: "",
  city: "Malda",
  state: "West Bengal",
  country: "India",
  pin_code: "732103",
};

// ── CREATE SHIPROCKET ORDER ──
async function createShipment(order) {
  const addr = order.deliveryAddress || {};

  // Calculate dimensions & weight for printed documents
  // Rough estimate: 100 pages ≈ 1cm thick, 500g
  const pageCount = (order.pages || 1) * (order.copies || 1);
  const weight = Math.max(0.5, (pageCount * 5) / 1000); // ~5g per page, min 500g
  const height = Math.max(2, Math.ceil(pageCount * 0.01)); // cm

  const dimensions = {
    length: order.paperSize === "A3" ? 42 : 30, // cm
    breadth: order.paperSize === "A3" ? 30 : 21,
    height: Math.min(height, 30),
    weight: Math.min(weight, 10), // kg
  };

  const payload = {
    order_id: order.orderId,
    order_date: new Date(order.createdAt).toISOString().slice(0, 10) + " " + new Date(order.createdAt).toTimeString().slice(0, 8),
    pickup_location: "PrintKaaro Warehouse",
    channel_id: "",
    comment: order.notes || "",
    billing_customer_name: addr.name || "Customer",
    billing_last_name: "",
    billing_address: addr.address || "",
    billing_address_2: "",
    billing_city: addr.city || "Malda",
    billing_pincode: addr.pincode || "",
    billing_state: addr.state || "West Bengal",
    billing_country: "India",
    billing_email: "",
    billing_phone: addr.phone || "",
    shipping_is_billing: true,
    order_items: [
      {
        name: `Printed Documents - ${order.fileName}`,
        sku: order.orderId,
        units: 1,
        selling_price: order.totalPrice || order.price,
        discount: 0,
        tax: 0,
        hsn: "4901", // HSN code for printed books/documents
      },
    ],
    payment_method: order.paymentMethod === "cash" ? "COD" : "Prepaid",
    sub_total: order.totalPrice || order.price,
    ...dimensions,
  };

  console.log("📦 Creating Shiprocket order:", order.orderId);
  const result = await srAPI("/orders/create/adhoc", "POST", payload);
  console.log("✅ Shiprocket order created:", result.order_id, "Shipment:", result.shipment_id);
  return result;
}

// ── CHECK COURIER SERVICEABILITY ──
async function checkServiceability(pincode, weight = 0.5, cod = false) {
  const pickup_pincode = "732103";
  const url = `/courier/serviceability/?pickup_postcode=${pickup_pincode}&delivery_postcode=${pincode}&weight=${weight}&cod=${cod ? 1 : 0}`;
  return await srAPI(url);
}

// ── GET AVAILABLE COURIERS FOR SHIPMENT ──
async function getCouriers(shipmentId) {
  const result = await srAPI(`/courier/courierListWithCounts`, "POST", {
    shipment_id: shipmentId,
  });
  return result;
}

// ── ASSIGN COURIER (generates AWB) ──
async function assignCourier(shipmentId, courierId) {
  const result = await srAPI("/courier/assign/ship", "POST", {
    shipment_id: [shipmentId],
    courier_id: courierId,
  });
  console.log("✅ Courier assigned, AWB:", result.response?.data?.awb_code);
  return result;
}

// ── GENERATE SHIPPING LABEL ──
async function generateLabel(shipmentId) {
  const result = await srAPI("/courier/generate/label", "POST", {
    shipment_id: [shipmentId],
  });
  return result;
}

// ── REQUEST PICKUP ──
async function requestPickup(shipmentId) {
  const result = await srAPI("/courier/generate/pickup", "POST", {
    shipment_id: [shipmentId],
  });
  return result;
}

// ── TRACK SHIPMENT ──
async function trackShipment(shipmentId) {
  return await srAPI(`/courier/track/shipment/${shipmentId}`);
}

// ── TRACK BY AWB ──
async function trackByAWB(awb) {
  return await srAPI(`/courier/track/awb/${awb}`);
}

// ── TRACK BY ORDER ID ──
async function trackByOrderId(orderId) {
  return await srAPI(`/courier/track?order_id=${orderId}`);
}

// ── CANCEL SHIPMENT ──
async function cancelShipment(shipmentIds) {
  return await srAPI("/orders/cancel", "POST", {
    ids: Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds],
  });
}

// ── ADD PICKUP ADDRESS (run once on setup) ──
async function addPickupAddress() {
  try {
    const result = await srAPI("/settings/company/addpickup", "POST", PICKUP_ADDRESS);
    console.log("✅ Pickup address added:", result);
    return result;
  } catch (e) {
    console.log("ℹ️ Pickup address may already exist:", e.message);
    return null;
  }
}

module.exports = {
  getToken,
  createShipment,
  checkServiceability,
  getCouriers,
  assignCourier,
  generateLabel,
  requestPickup,
  trackShipment,
  trackByAWB,
  trackByOrderId,
  cancelShipment,
  addPickupAddress,
  PICKUP_ADDRESS,
};
