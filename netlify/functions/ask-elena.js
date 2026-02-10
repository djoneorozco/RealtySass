// netlify/functions/ask-elena.js
// ============================================================
// v3.1.0 — RealtySaSS • Ask Elena (Realtor Mentor + SME)
// ✅ Adds: Real Estate Basics JSON pack (deterministic answers + prompt context)
// (Ported from PCSUnited ask-elena.js, refit for RealtySaSS)
//
// GOAL (RealtySaSS):
// - Elena is a Realtor-facing assistant + mentor + real-estate SME
// - Profile-aware (Supabase profiles lookup by email, with context fallback)
// - Deterministic answers for common Realtor workflows (checklists, scripts, compliance guardrails)
// - Deterministic answers for Real Estate fundamentals (escrow, contingencies, DTI, closing costs, etc.)
// - OpenAI fallback for natural language + writing + strategy (OPTIONAL)
//
// REQUIRED ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// OPTIONAL ENV:
//   OPENAI_API_KEY   (for non-deterministic questions)
// OPTIONAL ENV (recommended):
//   REALTYSASS_ALLOW_ORIGINS="https://realtysass.com,https://www.realtysass.com,https://realtysass.netlify.app,https://realtysass.webflow.io"
//
// NOTES:
// - Put basics JSON at: netlify/functions/data/ask-elena-realestate-basics.json
// - Ensure your netlify.toml includes:
//     [functions]
//     included_files = ["netlify/functions/data/**"]
// ============================================================

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

/* ============================================================
   //#0 — Real Estate Basics Pack (JSON)
   - Deterministic definitions and guardrails
   - Loaded once (cached) with safe fallback
============================================================ */
const BASICS_PATH = path.join(__dirname, "data", "ask-elena-realestate-basics.json");
let __basicsCache = null;
let __basicsLoadError = null;

function loadRealEstateBasics() {
  if (__basicsCache) return __basicsCache;
  if (__basicsLoadError) return null;

  try {
    const raw = fs.readFileSync(BASICS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    __basicsCache = parsed;
    return __basicsCache;
  } catch (err) {
    __basicsLoadError = String(err?.message || err);
    return null;
  }
}

function basicsForPrompt(basics) {
  if (!basics || typeof basics !== "object") return "";
  const meta = basics?.meta || {};
  const terms = Array.isArray(basics?.terminology_quick_hits)
    ? basics.terminology_quick_hits.slice(0, 8)
    : [];
  const contingencies = Array.isArray(basics?.process_flow?.common_contingencies)
    ? basics.process_flow.common_contingencies.slice(0, 4)
    : [];
  const thresholds = basics?.money_math?.rule_of_thumb_thresholds?.housing_ratio || null;

  const lines = [];
  if (meta?.name) lines.push(`${meta.name} (${meta.version || "v?"})`);
  if (meta?.purpose) lines.push(`Purpose: ${meta.purpose}`);
  if (thresholds) {
    lines.push(
      `Housing ratio guardrails (gross income): GREEN ≤ ${thresholds?.safe_zone?.max_percent_of_gross_income || 28}%, ` +
      `CAUTION ≤ ${thresholds?.caution_zone?.max_percent_of_gross_income || 33}%, ` +
      `NO-GO > ${thresholds?.no_go_zone?.above_percent_of_gross_income || 33}%`
    );
  }
  if (contingencies.length) {
    lines.push(
      `Common contingencies: ${contingencies.map(c => c.term).join(", ")}`
    );
  }
  if (terms.length) {
    lines.push(
      `Key terms: ${terms.map(t => t.term).join(", ")}`
    );
  }
  return lines.join("\n");
}

/* ============================================================
   //#1 — CORS (RealtySaSS)
============================================================ */
const DEFAULT_ALLOW_ORIGINS = [
  "https://realtysass.com",
  "https://www.realtysass.com",
  "https://realtysass.netlify.app",

  "https://realtysass.webflow.io",
  "https://www.realtysass.webflow.io",

  "http://localhost:8888",
  "http://localhost:3000",
];

function readAllowOriginsFromEnv() {
  const raw = String(process.env.REALTYSASS_ALLOW_ORIGINS || "").trim();
  if (!raw) return DEFAULT_ALLOW_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOW_ORIGINS = readAllowOriginsFromEnv();

function corsHeaders(origin) {
  const o = String(origin || "").trim();
  const allow = ALLOW_ORIGINS.includes(o) ? o : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Content-Type": "application/json",
  };
}

function respond(statusCode, headers, payload) {
  return { statusCode, headers, body: JSON.stringify(payload || {}) };
}

/* ============================================================
   //#2 — Supabase profile fields (kept compatible)
============================================================ */
const SELECT_COLS = [
  "id",
  "created_at",
  "profiles_user_id_unique",
  "email",
  "full_name",
  "first_name",
  "last_name",
  "phone",
  "mode",
  "notes"
].join(",");

/* ============================================================
   //#3 — Utility helpers
============================================================ */
function safeStr(x) {
  const s = String(x ?? "").trim();
  return s || "";
}

function normalizeEmail(x) {
  return safeStr(x).toLowerCase();
}

function pickName(profile) {
  const full = safeStr(profile?.full_name);
  const first = safeStr(profile?.first_name);
  const last = safeStr(profile?.last_name);

  if (full) return { full, first: first || full.split(/\s+/)[0] || "", last: last || "" };
  if (first || last) return { full: `${first} ${last}`.trim(), first, last };
  return { full: "", first: "", last: "" };
}

function getEmailFromPayload(payload) {
  const direct = normalizeEmail(payload?.email);
  if (direct) return direct;

  const ident = normalizeEmail(payload?.identity?.email);
  if (ident) return ident;

  const ctxEmail = normalizeEmail(payload?.context?.email);
  if (ctxEmail) return ctxEmail;

  const ctxProfEmail = normalizeEmail(payload?.context?.profile?.email);
  if (ctxProfEmail) return ctxProfEmail;

  return "";
}

function money(n) {
  const x = Number(n) || 0;
  return x.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

/* ============================================================
   //#4 — Deterministic “RealtySaSS” knowledge & utilities
============================================================ */
function buildProductHelpReply(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("buyerbrief")) {
    return [
      "BuyerBrief™ is the timeline-first buyer workspace.",
      "Use it to capture milestones (pre-approval → showings → offer → option period → close), assign next steps, and keep everything organized for the client and your team.",
      "Tell me where the deal is stuck (pre-approval, inventory, offer terms, repairs, appraisal) and I’ll give you the next 3 moves + the exact message to send."
    ].join("\n");
  }

  if (t.includes("crm")) {
    return [
      "RealtySaSS CRM is the pipeline + follow-up engine (when enabled in your stack).",
      "Think: stages, tasks, reminders, notes, and clean handoffs between buyer timeline + your pipeline.",
      "Tell me your current lead stage + timeframe, and I’ll write a follow-up sequence (text + email) that doesn’t sound desperate."
    ].join("\n");
  }

  if (t.includes("ask elena") || t.includes("elena")) {
    return [
      "Ask Elena is your Realtor-side command center: quick answers, scripts, negotiation prep, client coaching, and deal triage.",
      "Drop a situation + constraints (price point, timeline, financing type, inspection issues) and I’ll give you a BLUF + a plan."
    ].join("\n");
  }

  return [
    "RealtySaSS is built to help you move deals faster with less chaos:",
    "• Buyer/seller workflow checklists",
    "• Scripts (texts/emails/call openers)",
    "• Negotiation prep + risk flags",
    "• Deal triage (what to do next, what to ask for)",
    "",
    "Tell me what you’re working on (buyer, seller, investor) and what’s blocking the deal."
  ].join("\n");
}

function buildWorkflowReply(kind) {
  if (kind === "buyer_workflow") {
    return [
      "Buyer Workflow — clean, repeatable:",
      "1) Intake: timeline, must-haves, budget ceiling, financing type, down payment, HOA tolerance.",
      "2) Pre-approval: lender + max payment comfort (not just max approval).",
      "3) Search rules: neighborhoods, commute, school/amenities, deal-breakers.",
      "4) Showing strategy: 5–8 homes per batch, same-day notes, rank top 3.",
      "5) Offer plan: comps, concessions target, inspection posture, escalation rules (if any).",
      "6) Option/inspection: negotiate safety + big-ticket items first.",
      "7) Appraisal: prepare comp packet if needed, plan B if low appraisal.",
      "8) Clear-to-close: utilities, final walk, repair receipts, closing funds verified."
    ].join("\n");
  }

  if (kind === "seller_workflow") {
    return [
      "Listing Workflow — win the week:",
      "1) Positioning: target buyer, value story, top 3 differentiators.",
      "2) Prep: declutter, paint-touch, lighting, curb pop, clean.",
      "3) Pricing: comp set + one ‘brutally honest’ anchor + plan for first 7 days.",
      "4) Media: photos first, then copy (not the other way around).",
      "5) Launch: schedule blocks, agent notes, showing windows, offer deadline rules.",
      "6) Negotiate: prioritize net + certainty + timeline (not ego).",
      "7) Under contract: inspection expectations + repair strategy + backup buyer posture."
    ].join("\n");
  }

  if (kind === "investor_workflow") {
    return [
      "Investor Workflow — don’t get cute, get paid:",
      "1) Define target: buy & hold vs flip vs mid-term.",
      "2) Underwrite: rent comps, taxes/ins/HOA, vacancy, repairs, reserves.",
      "3) Exit plan: resale comps + days-on-market reality check.",
      "4) Offer terms: speed + inspection posture + financing certainty.",
      "5) Execution: contractor scope, timeline, budget buffer, change-order discipline."
    ].join("\n");
  }

  return "Tell me if this is a buyer, seller, or investor deal — I’ll drop the exact workflow.";
}

function buildScriptReply(kind, context) {
  const buyerName = safeStr(context?.buyer?.name) || "your buyer";
  const address = safeStr(context?.listing?.address) || "the property";
  const issue = safeStr(context?.issue) || "";

  if (kind === "followup_no_response") {
    return [
      "Text (no response follow-up):",
      `"Quick ping — still want me to line up options for you this week, or should I pause for now?"`,
      "",
      "If they answer “pause,” you stay in control:",
      `"No problem. Want me to circle back next week, or later this month?"`
    ].join("\n");
  }

  if (kind === "buyer_offer_intro") {
    return [
      "Offer Intro (Agent → Listing Agent):",
      `"Hey — I’m bringing you a clean offer on ${address}. ${buyerName} is motivated and we’re aiming for a smooth close. What matters most to your seller: price, timeline, or certainty?"`,
      "",
      "Follow-up if they say “certainty”:",
      `"Perfect — I’ll structure it to reduce friction and keep inspections tight. Any preferred title/lender or dates we should align to?"`
    ].join("\n");
  }

  if (kind === "inspection_pushback") {
    return [
      "Inspection Pushback (keep it calm, firm):",
      `"Totally get it. We’re not trying to nickel-and-dime — we’re focusing on health/safety and big-ticket items that affect financing. If we can address these, we can keep the deal on track."`,
      issue ? `\n"Specifically: ${issue}"` : "",
      "",
      "Then give them options:",
      "• Repair by licensed pro + receipt",
      "• Credit at closing",
      "• Price adjustment (if it’s structural/roof/HVAC)"
    ].join("\n");
  }

  if (kind === "seller_price_reality") {
    return [
      "Seller Pricing Reality Check (respectful, decisive):",
      `"Here’s the honest read: the market will tell us in the first 7 days. If we’re priced right, we’ll get strong traffic and at least one serious offer. If not, we adjust fast — not after we go stale."`,
      "",
      `"I’d rather price to win than chase the market down."`
    ].join("\n");
  }

  return [
    "Tell me what you need a script for:",
    "• Lead follow-up",
    "• Offer intro",
    "• Inspection negotiation",
    "• Low appraisal",
    "• Price reduction conversation",
    "",
    "Drop the situation in one sentence and I’ll write it."
  ].join("\n");
}

function buildComplianceReply(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("fair housing") || t.includes("protected class") || t.includes("discrimination")) {
    return [
      "Fair Housing guardrails (high-level):",
      "• Focus on property features, pricing, and objective criteria — not people.",
      "• Avoid steering language (schools, neighborhoods ‘for families,’ ‘safe,’ etc.).",
      "• If a client requests something that touches protected classes, redirect to objective criteria and let them choose.",
      "",
      "Paste the exact sentence you’re about to say/write and I’ll clean it up safely."
    ].join("\n");
  }

  if (t.includes("disclosure") || t.includes("material defect") || t.includes("seller disclosure")) {
    return [
      "Disclosure (high-level):",
      "• When in doubt, disclose — and document it.",
      "• Keep it factual, dated, and consistent with your state forms.",
      "• For legal interpretation, loop in your broker or an attorney.",
      "",
      "Tell me your state and the issue (one line) and I’ll suggest the safest way to phrase it (non-legal)."
    ].join("\n");
  }

  return [
    "Compliance mode:",
    "I can help you phrase things safely and professionally — but for legal calls, use your broker/attorney as the final authority.",
    "Paste what you’re about to send and I’ll rewrite it clean."
  ].join("\n");
}

/* ============================================================
   //#4B — Deterministic: Real Estate Basics answers (from JSON)
============================================================ */
function normalizeTextForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreHit(query, candidate) {
  const q = normalizeTextForMatch(query);
  const c = normalizeTextForMatch(candidate);
  if (!q || !c) return 0;
  if (c === q) return 8;
  if (c.includes(q)) return 6;
  const qWords = q.split(" ").filter(Boolean);
  let hits = 0;
  for (const w of qWords) if (w.length > 2 && c.includes(w)) hits++;
  return hits;
}

function findBestMatches(userText, basics) {
  const q = normalizeTextForMatch(userText);
  if (!q || !basics) return [];

  const pools = [];

  // terminology
  if (Array.isArray(basics?.terminology_quick_hits)) {
    for (const item of basics.terminology_quick_hits) {
      pools.push({
        type: "term",
        title: item?.term || "",
        meaning: item?.meaning || ""
      });
    }
  }

  // parties + docs
  if (Array.isArray(basics?.core_concepts?.parties)) {
    for (const item of basics.core_concepts.parties) {
      pools.push({
        type: "party",
        title: item?.term || "",
        meaning: item?.meaning || ""
      });
    }
  }
  if (Array.isArray(basics?.core_concepts?.key_documents)) {
    for (const item of basics.core_concepts.key_documents) {
      pools.push({
        type: "doc",
        title: item?.term || "",
        meaning: item?.meaning || ""
      });
    }
  }

  // contingencies
  if (Array.isArray(basics?.process_flow?.common_contingencies)) {
    for (const item of basics.process_flow.common_contingencies) {
      pools.push({
        type: "contingency",
        title: item?.term || "",
        meaning: item?.why_it_exists || ""
      });
    }
  }

  // metrics
  const metrics = basics?.money_math?.key_metrics || {};
  for (const k of Object.keys(metrics)) {
    pools.push({
      type: "metric",
      title: k,
      meaning: `${metrics?.[k]?.meaning || ""} ${metrics?.[k]?.why_it_matters ? "— " + metrics[k].why_it_matters : ""}`.trim()
    });
  }

  // payment components
  if (Array.isArray(basics?.money_math?.monthly_payment_components)) {
    for (const item of basics.money_math.monthly_payment_components) {
      pools.push({
        type: "payment_component",
        title: item?.component || "",
        meaning: item?.meaning || ""
      });
    }
  }

  // closing costs
  const cc = basics?.money_math?.closing_costs_ranges || {};
  if (cc?.buyer_closing_costs_percent) {
    pools.push({
      type: "closing_costs",
      title: "Buyer Closing Costs",
      meaning: `Typical: ${cc.buyer_closing_costs_percent.typical || "2%–5%"} of purchase price. ${cc.buyer_closing_costs_percent.note || ""}`.trim()
    });
  }
  if (cc?.seller_concessions) {
    pools.push({
      type: "closing_costs",
      title: "Seller Concessions",
      meaning: `${cc.seller_concessions.meaning || ""} Tradeoff: ${cc.seller_concessions.tradeoff || ""}`.trim()
    });
  }

  // risk flags (useful when user asks “red flags”)
  if (Array.isArray(basics?.property_risk_flags?.major_red_flags)) {
    pools.push({
      type: "risk",
      title: "Major Red Flags",
      meaning: basics.property_risk_flags.major_red_flags.join("; ")
    });
  }

  const scored = pools
    .map((p) => {
      const s1 = scoreHit(q, p.title);
      const s2 = scoreHit(q, p.meaning);
      return { ...p, score: Math.max(s1, s2) };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return scored;
}

function buildBasicsReply(userText, basics) {
  const matches = findBestMatches(userText, basics);

  // If they asked broadly for “basics”, give a structured overview
  const t = normalizeTextForMatch(userText);
  const broad =
    t.includes("basics") ||
    t.includes("real estate 101") ||
    t.includes("explain the process") ||
    t.includes("how does buying a house work") ||
    t.includes("home buying steps");

  if (broad && basics?.process_flow?.home_buying_steps) {
    const steps = basics.process_flow.home_buying_steps
      .slice(0, 7)
      .map((s) => `${s.step}) ${s.name}`)
      .join("\n");

    const contingencies = Array.isArray(basics?.process_flow?.common_contingencies)
      ? basics.process_flow.common_contingencies.map((c) => `• ${c.term}: ${c.why_it_exists}`).join("\n")
      : "";

    const cc = basics?.money_math?.closing_costs_ranges?.buyer_closing_costs_percent?.typical || "2%–5%";
    const guard = basics?.money_math?.rule_of_thumb_thresholds?.housing_ratio || null;

    return [
      `BLUF: Real estate is a timeline + paperwork machine — win it by controlling *deadlines, risk, and money math*.`,
      "",
      "The 7-step flow:",
      steps,
      "",
      `Money reality: buyer closing costs are typically ${cc} of price (ballpark).`,
      guard
        ? `Affordability guardrail: keep housing ≤ ${guard.safe_zone.max_percent_of_gross_income}% gross for “GREEN”; ≤ ${guard.caution_zone.max_percent_of_gross_income}% is “CAUTION”.`
        : "",
      "",
      contingencies ? "Most common contingencies:\n" + contingencies : "",
      "",
      "Tell me what you want next: definitions (escrow/earnest/option), negotiation (inspection/appraisal), or client scripts."
    ].filter(Boolean).join("\n");
  }

  // Otherwise answer the specific term(s) they asked
  if (matches.length) {
    const top = matches[0];
    const bullets = matches.slice(0, 4).map((m) => `• ${m.title}: ${m.meaning}`).join("\n");

    const guard = basics?.money_math?.rule_of_thumb_thresholds?.housing_ratio || null;
    const guardLine = guard
      ? `Guardrail: housing ≤ ${guard.safe_zone.max_percent_of_gross_income}% gross (GREEN), ≤ ${guard.caution_zone.max_percent_of_gross_income}% (CAUTION).`
      : "";

    return [
      `BLUF: Here’s the clean definition for **${top.title}** — and what to watch.`,
      "",
      bullets,
      guardLine ? "\n" + guardLine : "",
      "",
      "If you tell me the state + deal stage (offer / option / appraisal / close), I’ll translate this into the exact move + wording."
    ].filter(Boolean).join("\n");
  }

  // Fallback when basics pack can’t match well
  return [
    "BLUF: I can explain it — tell me the exact term or situation.",
    "Examples: escrow, earnest money, option period, contingencies, DTI, appraisal gap, seller concessions, closing disclosure.",
    "",
    "Ask it like this: “Elena, explain escrow in 3 bullets and what buyers mess up.”"
  ].join("\n");
}

/* ============================================================
   //#5 — Intent detection (simple + reliable)
============================================================ */
function detectIntent(text) {
  const t = String(text || "").toLowerCase();

  // Real Estate fundamentals / definitions / 101
  if (
    t.includes("real estate basics") ||
    t.includes("real estate 101") ||
    t.includes("home buying process") ||
    t.includes("how does buying a house work") ||
    t.includes("what is escrow") ||
    t.includes("what is earnest") ||
    t.includes("what is option fee") ||
    t.includes("what is contingency") ||
    t.includes("what is dti") ||
    t.includes("what is ltv") ||
    t.includes("closing costs") ||
    t.includes("seller concessions") ||
    t.includes("appraisal contingency")
  ) return { type: "realestate_basics" };

  // Profile awareness
  if (
    t.includes("my profile") ||
    t.includes("profile loaded") ||
    t.includes("who am i") ||
    (t.includes("my") && (t.includes("name") || t.includes("phone") || t.includes("email")))
  ) return { type: "profile_question" };

  // Product / platform help
  if (
    t.includes("buyerbrief") ||
    t.includes("crm") ||
    t.includes("realtysass") ||
    t.includes("ask elena") ||
    t.includes("how does this work") ||
    t.includes("pricing") ||
    t.includes("subscription")
  ) return { type: "product_question" };

  // Workflows
  if (
    t.includes("buyer workflow") ||
    t.includes("buyer process") ||
    t.includes("first-time buyer") ||
    t.includes("offer strategy") ||
    t.includes("under contract") ||
    t.includes("inspection") ||
    t.includes("appraisal") ||
    t.includes("closing")
  ) return { type: "workflow_question" };

  if (
    t.includes("listing workflow") ||
    t.includes("seller workflow") ||
    t.includes("listing strategy") ||
    t.includes("price reduction") ||
    t.includes("days on market") ||
    t.includes("stale listing")
  ) return { type: "workflow_question" };

  if (
    t.includes("investor") ||
    t.includes("flip") ||
    t.includes("buy and hold") ||
    t.includes("cash flow") ||
    t.includes("rental")
  ) return { type: "workflow_question" };

  // Scripts / messaging
  if (
    t.includes("script") ||
    t.includes("text message") ||
    t.includes("follow up") ||
    t.includes("follow-up") ||
    t.includes("email") ||
    t.includes("call opener") ||
    t.includes("what do i say")
  ) return { type: "script_request" };

  // Compliance guardrails
  if (
    t.includes("fair housing") ||
    t.includes("protected class") ||
    t.includes("discrimination") ||
    t.includes("disclosure") ||
    t.includes("material defect") ||
    t.includes("legal")
  ) return { type: "compliance_question" };

  return null;
}

/* ============================================================
   //#6 — Main handler
============================================================ */
module.exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return respond(204, headers, {});
  if (event.httpMethod !== "POST") return respond(405, headers, { error: "Method Not Allowed" });

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, headers, { error: "Invalid JSON body" });
  }

  const userText = safeStr(payload.message);
  if (!userText) return respond(400, headers, { error: "Missing message" });

  // Load Real Estate Basics pack (safe)
  const basics = loadRealEstateBasics();

  // Context (optional)
  const context = payload?.context && typeof payload.context === "object" ? payload.context : {};
  const contextProfile =
    context?.profile && typeof context.profile === "object" ? context.profile : null;

  // Supabase profile lookup
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const email = getEmailFromPayload(payload);
  let profile = null;
  let usedSupabase = false;
  let supabaseError = null;

  if (email && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await supabase
        .from("profiles")
        .select(SELECT_COLS)
        .eq("email", email)
        .maybeSingle();

      if (error) supabaseError = String(error.message || error);
      if (!error && data) {
        profile = data;
        usedSupabase = true;
      }
    } catch (err) {
      supabaseError = String(err);
    }
  }

  // Context fallback
  if (!profile && contextProfile) profile = contextProfile;

  const name = pickName(profile);
  const profileContext = profile
    ? {
        email: normalizeEmail(profile.email || email) || null,
        full_name: name.full || null,
        first_name: safeStr(profile.first_name) || name.first || null,
        last_name: safeStr(profile.last_name) || name.last || null,
        phone: safeStr(profile.phone) || null,
        mode: safeStr(profile.mode) || null,
        notes: safeStr(profile.notes) || null,
      }
    : null;

  const intent = detectIntent(userText);

  /* ==========================================================
     //#6.1 — Deterministic: Real Estate Basics (from JSON)
  ========================================================== */
  if (intent?.type === "realestate_basics") {
    const reply = buildBasicsReply(userText, basics);
    return respond(200, headers, {
      intent: "realestate_basics",
      reply,
      profile: profileContext || null,
      basics_meta: basics?.meta || null,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null
      }
    });
  }

  /* ==========================================================
     //#6.2 — Deterministic: Profile
  ========================================================== */
  if (intent?.type === "profile_question") {
    if (!profileContext || !profileContext.email) {
      return respond(200, headers, {
        intent: "profile_question",
        reply:
          "I can pull your profile instantly once your email is synced. Send your email (or load your profile in the shell) and I’ll greet you properly + use your saved info.",
        profile: null,
        debug: {
          basicsLoaded: !!basics,
          basicsLoadError: __basicsLoadError || null,
          usedSupabase,
          hasContextProfile: !!contextProfile,
          supabaseError: supabaseError || null,
        },
      });
    }

    const bits = [];
    bits.push(`Got you. I have: ${profileContext.full_name || "your profile"} on file.`);
    if (profileContext.phone) bits.push(`Phone: ${profileContext.phone}`);
    if (profileContext.mode) bits.push(`Mode: ${profileContext.mode}`);
    return respond(200, headers, {
      intent: "profile_question",
      reply: bits.join("\n"),
      profile: profileContext,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
      },
    });
  }

  /* ==========================================================
     //#6.3 — Deterministic: Product help
  ========================================================== */
  if (intent?.type === "product_question") {
    const reply = buildProductHelpReply(userText);
    return respond(200, headers, {
      intent: "product_question",
      reply,
      profile: profileContext || null,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
      },
    });
  }

  /* ==========================================================
     //#6.4 — Deterministic: Workflows
  ========================================================== */
  if (intent?.type === "workflow_question") {
    const t = userText.toLowerCase();

    let kind = null;
    if (t.includes("listing") || t.includes("seller")) kind = "seller_workflow";
    else if (t.includes("investor") || t.includes("flip") || t.includes("rental") || t.includes("cash flow")) kind = "investor_workflow";
    else kind = "buyer_workflow";

    const reply = buildWorkflowReply(kind);
    return respond(200, headers, {
      intent: "workflow_question",
      reply,
      profile: profileContext || null,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
      },
    });
  }

  /* ==========================================================
     //#6.5 — Deterministic: Scripts
  ========================================================== */
  if (intent?.type === "script_request") {
    const t = userText.toLowerCase();
    let kind = "menu";

    if (t.includes("no response") || t.includes("ghost") || t.includes("follow up")) kind = "followup_no_response";
    if (t.includes("offer") || t.includes("listing agent")) kind = "buyer_offer_intro";
    if (t.includes("inspection") || t.includes("repairs")) kind = "inspection_pushback";
    if (t.includes("price reduction") || t.includes("reduce") || t.includes("stale")) kind = "seller_price_reality";

    const reply = buildScriptReply(kind, context || {});
    return respond(200, headers, {
      intent: "script_request",
      reply,
      profile: profileContext || null,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
      },
    });
  }

  /* ==========================================================
     //#6.6 — Deterministic: Compliance guardrails
  ========================================================== */
  if (intent?.type === "compliance_question") {
    const reply = buildComplianceReply(userText);
    return respond(200, headers, {
      intent: "compliance_question",
      reply,
      profile: profileContext || null,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
      },
    });
  }

  /* ==========================================================
     //#6.7 — OpenAI fallback (optional)
  ========================================================== */
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const who = profileContext?.full_name ? `I see you as ${profileContext.full_name}.` : "I don’t see your profile yet.";
    return respond(200, headers, {
      intent: "fallback_no_openai",
      reply: `Elena (dev echo): “${userText}” — ${who} Add OPENAI_API_KEY for natural-language answers, rewriting, and strategy.`,
      profile: profileContext || null,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
      },
    });
  }

  // Build a clean, Realtor-mentor system prompt (BLUF-first, safe, actionable)
  const basicsSummary = basicsForPrompt(basics);

  const system = [
    "You are Elena, the RealtySaSS Realtor-side AI assistant and mentor.",
    "Tone: confident, warm, slightly daring, but professional. Never explicit.",
    "Style: BLUF-first, then bullets. Actionable. No fluff.",
    "When user asks for a script: provide a ready-to-send version (text/email/call opener).",
    "When user asks for a plan: give next 3 moves + what to ask for.",
    "If user asks for comps/prices: ask for location + 2–3 comparable anchors (you do not have MLS access).",
    "Compliance: avoid steering/discrimination; use safe wording; recommend broker/attorney for legal interpretation.",
    "Use the provided profile + context as truth. If missing, ask for only the minimum needed.",
    basicsSummary ? `\n\nREFERENCE — Real Estate Basics Pack:\n${basicsSummary}\n` : ""
  ].join(" ");

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 650,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              message: userText,
              profile: profileContext,
              context: context || null,
              basics_meta: basics?.meta || null,
              note:
                "Give BLUF first. Then bullets. If you need info, ask for only the minimum missing inputs once."
            }),
          },
        ],
      }),
    });

    const data = await resp.json();
    const reply =
      (data?.choices?.[0]?.message?.content || "").trim() ||
      "I’m here. Tell me the deal situation in one sentence and what outcome you want.";

    return respond(200, headers, {
      intent: "openai_fallback",
      reply,
      profile: profileContext || null,
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        model: "gpt-4o-mini",
      },
    });
  } catch (err) {
    return respond(500, headers, {
      error: "Server exception",
      detail: String(err),
      debug: {
        basicsLoaded: !!basics,
        basicsLoadError: __basicsLoadError || null,
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
      },
    });
  }
};
