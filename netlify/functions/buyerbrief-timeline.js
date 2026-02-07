// netlify/functions/buyerbrief-timeline.js
// ============================================================
// BuyerBrief™ • Timeline Persistence API
// v1.0.0
// ✅ Saves/loads BuyerBrief timelines in Supabase (server-side service key)
// ✅ Upsert by (email, buyerbrief_id)
// ============================================================

const { createClient } = require("@supabase/supabase-js");

const ALLOW_ORIGINS = [
  "https://pcsunited.webflow.io",
  "https://www.pcsunited.webflow.io",
  "https://new-real-estate-purchase.webflow.io",
  "https://www.new-real-estate-purchase.webflow.io",
  "https://pcsunited.netlify.app",
  "https://www.pcsunited.netlify.app",
];

function corsHeaders(origin) {
  const ok = origin && (ALLOW_ORIGINS.includes(origin) || origin.endsWith(".webflow.io"));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function respond(statusCode, payload, origin) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true }, origin);
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed" }, origin);
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return respond(
        500,
        { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY" },
        origin
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").toLowerCase();

    const email = String(body.email || "").trim().toLowerCase();
    const buyerbrief_id = String(body.buyerbrief_id || "").trim();
    const version = String(body.version || "2A-timeline.v1").trim();

    if (!email || !buyerbrief_id) {
      return respond(
        400,
        { ok: false, error: "Missing required fields: email, buyerbrief_id" },
        origin
      );
    }

    // ============================================================
    // #1 GET
    // ============================================================
    if (action === "get") {
      const { data, error } = await supabase
        .from("buyerbrief_timelines")
        .select("*")
        .eq("email", email)
        .eq("buyerbrief_id", buyerbrief_id)
        .order("updated_at", { ascending: false })
        .limit(1);

      if (error) return respond(500, { ok: false, error: error.message }, origin);

      const row = (data && data[0]) || null;
      return respond(200, { ok: true, row }, origin);
    }

    // ============================================================
    // #2 UPSERT (SAVE)
    // ============================================================
    if (action === "upsert") {
      const timeline_json = body.timeline_json || {};

      const payload = {
        email,
        buyerbrief_id,
        timeline_json,
        version,
        last_updated_by: email,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("buyerbrief_timelines")
        .upsert(payload, { onConflict: "email,buyerbrief_id" })
        .select("*")
        .limit(1);

      if (error) return respond(500, { ok: false, error: error.message }, origin);

      return respond(200, { ok: true, row: (data && data[0]) || null }, origin);
    }

    return respond(400, { ok: false, error: "Invalid action. Use: get | upsert" }, origin);
  } catch (e) {
    return respond(500, { ok: false, error: e.message || "Server error" }, origin);
  }
};
