// netlify/functions/ask-elena.js
// ============================================================
// v3.2.0 — RealtySaSS • Ask Elena (Realtor Mentor + SME)
//
// ✅ ENFORCED ELENA BEHAVIOR (Training-locked):
//   - Quick win first (real answer + usable asset)
//   - Keep convo moving (ask ONE crisp question)
//   - Soft conversion pivot (login/account = saved work + BuyerProfile automation)
//   - Two-choice close ONLY for ghost behavior scripts
//   - SMS scripts <= 400 chars when requested (auto-short)
//
// ✅ FLOW:
//   1) Call /api/elena-agent FIRST (truth packet + knowledge)
//   2) If affordability/deal-math: deterministic reply from agent
//   3) Else: deterministic intents (workflow/scripts/compliance/product/profile)
//   4) Optional OpenAI narration using agent packet as context
// ============================================================

const { createClient } = require("@supabase/supabase-js");

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
   //#2 — Supabase profile fields (keep only what exists)
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
  "notes",
  // Optional if exists in your profiles table:
  // "license_state",
  // "state",
  // "market_state",
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

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function formatMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "$0";
  return x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function wantsSmsLimit(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;

  // Explicit char counts
  const m = t.match(/(?:<=|<|under|max|up to)\s*(\d{2,4})\s*(?:chars|characters|char)\b/);
  if (m && Number(m[1])) return clampInt(Number(m[1]), 80, 2000);

  // Common "SMS" request
  if (t.includes("sms") || t.includes("text") || t.includes("text message")) {
    // Default to 400 unless specified
    return 400;
  }

  return null;
}

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function squeezeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function hardTrimToChars(s, maxChars) {
  const raw = squeezeSpaces(s);
  if (!maxChars || !Number.isFinite(maxChars)) return raw;
  if (raw.length <= maxChars) return raw;

  // Try to trim at sentence boundary
  const cut = raw.slice(0, maxChars);
  const lastPunct = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("?"), cut.lastIndexOf("!"));
  if (lastPunct > 80) return cut.slice(0, lastPunct + 1).trim();

  // Else trim at last space
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 80) return cut.slice(0, lastSpace).trim() + "…";

  return cut.trim() + "…";
}

function isGhostBehavior(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return (
    t.includes("ghost") ||
    t.includes("no response") ||
    t.includes("not responding") ||
    t.includes("not replying") ||
    t.includes("went silent") ||
    t.includes("radio silent") ||
    t.includes("left on read") ||
    (t.includes("follow") && t.includes("up") && (t.includes("silent") || t.includes("reply")))
  );
}

function userInitiatedFlirty(text) {
  // IMPORTANT: We keep this conservative; Elena stays professional.
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return (
    t.includes("😉") ||
    t.includes("😏") ||
    t.includes("flirt") ||
    t.includes("sexy") ||
    t.includes("you got my attention") ||
    t.includes("vibe")
  );
}

/* ============================================================
   //#4 — Deterministic replies (base content)
============================================================ */
function buildProductHelpReply(text, agent) {
  const t = String(text || "").toLowerCase();

  // If agent knowledge has realtysass packet, prefer it lightly
  const rs = agent?.knowledge?.realtysass || null;

  if (t.includes("buyerbrief") || t.includes("buyerprofile")) {
    const base = [
      "BuyerProfile / BuyerBrief™ is your timeline-first buyer workspace.",
      "Use it to capture milestones (pre-approval → showings → offer → option period → close), assign next steps, and keep your client moving without chaos.",
      "Tell me where the deal is stuck (pre-approval, inventory, offer terms, repairs, appraisal) and I’ll give you the next 3 moves + the exact message to send.",
    ];

    if (rs?.buyerprofile_one_liner) base.unshift(String(rs.buyerprofile_one_liner));
    return base.join("\n");
  }

  if (t.includes("crm")) {
    const base = [
      "RealtySaSS CRM is pipeline + follow-up (when enabled in your stack).",
      "Think: stages, tasks, reminders, notes, and clean handoffs between BuyerProfile + your pipeline.",
      "Tell me your lead stage + timeframe, and I’ll write a follow-up sequence (text + email) that doesn’t sound desperate.",
    ];
    if (rs?.crm_one_liner) base.unshift(String(rs.crm_one_liner));
    return base.join("\n");
  }

  if (t.includes("ask elena") || t.includes("elena")) {
    return [
      "Ask Elena is your Realtor-side command center: quick answers, scripts, negotiation prep, client coaching, and deal triage.",
      "Drop a situation + constraints (timeline, financing, inspection/appraisal issues) and I’ll answer BLUF-first.",
    ].join("\n");
  }

  if (t.includes("pricing") || t.includes("subscription") || t.includes("plans")) {
    // We keep this generic unless you store plans in realtysass.json
    if (rs?.pricing_bluf) {
      return [
        String(rs.pricing_bluf),
        "",
        "If you tell me: (1) solo vs team, (2) volume per month, (3) what you want automated, I’ll point you to the best-fit plan.",
      ].join("\n");
    }

    return [
      "Pricing is built around one thing: how much you want automated vs handled manually.",
      "Tell me if you’re solo or team + how many active buyers you run at once, and I’ll recommend the cleanest fit.",
    ].join("\n");
  }

  return [
    "RealtySaSS helps you move deals faster with less chaos:",
    "• Buyer/seller workflow checklists",
    "• Scripts (texts/emails/call openers)",
    "• Negotiation prep + risk flags",
    "• Deal triage (what to do next, what to ask for)",
    "",
    "Tell me what you’re working on (buyer, seller, investor) + what’s blocking the deal.",
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
      "8) Clear-to-close: utilities, final walk, repair receipts, closing funds verified.",
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
      "7) Under contract: inspection expectations + repair strategy + backup buyer posture.",
    ].join("\n");
  }

  if (kind === "investor_workflow") {
    return [
      "Investor Workflow — don’t get cute, get paid:",
      "1) Define target: buy & hold vs flip vs mid-term.",
      "2) Underwrite: rent comps, taxes/ins/HOA, vacancy, repairs, reserves.",
      "3) Exit plan: resale comps + days-on-market reality check.",
      "4) Offer terms: speed + inspection posture + financing certainty.",
      "5) Execution: contractor scope, timeline, budget buffer, change-order discipline.",
    ].join("\n");
  }

  return "Tell me if this is a buyer, seller, or investor deal — I’ll drop the exact workflow.";
}

function buildScriptReply(kind, context, opts) {
  const buyerName = safeStr(context?.buyer?.name) || "your buyer";
  const address = safeStr(context?.listing?.address) || "the property";
  const issue = safeStr(context?.issue) || "";
  const smsLimit = Number.isFinite(opts?.smsLimit) ? opts.smsLimit : null;

  // IMPORTANT RULE:
  // - Two-choice close ONLY for ghost behavior follow-ups
  // - Otherwise single CTA

  if (kind === "followup_no_response") {
    const script = `"Quick check — do you want me to keep lining up options this week, or should I pause for now?"`;
    const follow = `"No problem. Want me to circle back next week, or later this month?"`;

    const out = [
      "Text (ghost/no response):",
      hardTrimToChars(script, smsLimit),
      "",
      "If they answer “pause,” keep control:",
      hardTrimToChars(follow, smsLimit),
    ].join("\n");

    return out;
  }

  if (kind === "followup_after_showing") {
    const script = `"Good seeing homes today — quick yes/no: should I book 2–3 more that match your top priority, or did anything we saw change what you want?"`;
    return [
      "Text (post-showing follow-up):",
      hardTrimToChars(script, smsLimit),
    ].join("\n");
  }

  if (kind === "buyer_offer_intro") {
    const a = `"Hey — I’m bringing you a clean offer on ${address}. ${buyerName} is motivated and we’re aiming for a smooth close. What matters most to your seller: price, timeline, or certainty?"`;
    const b = `"Perfect — I’ll structure it to reduce friction. Any preferred title company, lender, or dates we should align to?"`;

    return [
      "Offer Intro (Agent → Listing Agent):",
      hardTrimToChars(a, smsLimit),
      "",
      "Follow-up if they say “certainty”:",
      hardTrimToChars(b, smsLimit),
    ].join("\n");
  }

  if (kind === "inspection_pushback") {
    const a = `"Totally get it. We’re not trying to nickel-and-dime — we’re focusing on health/safety and big-ticket items that affect financing. If we can address these, we can keep the deal on track."`;
    const b = issue ? `"Specifically: ${issue}"` : "";
    const c = "Options: repair by licensed pro + receipt • credit at closing • price adjustment (roof/HVAC/structural)";

    return [
      "Inspection Pushback (calm, firm):",
      hardTrimToChars(a, smsLimit),
      b ? hardTrimToChars(b, smsLimit) : "",
      "",
      hardTrimToChars(c, smsLimit),
    ].filter(Boolean).join("\n");
  }

  if (kind === "seller_price_reality") {
    const a = `"Here’s the honest read: the market tells us in the first 7 days. If we’re priced right, we get traffic and a serious offer. If not, we adjust fast — not after we go stale."`;
    const b = `"I’d rather price to win than chase the market down."`;

    return [
      "Seller Pricing Reality Check:",
      hardTrimToChars(a, smsLimit),
      hardTrimToChars(b, smsLimit),
    ].join("\n");
  }

  return [
    "Tell me what you need a script for:",
    "• Lead follow-up",
    "• Post-showing follow-up",
    "• Offer intro",
    "• Inspection negotiation",
    "• Low appraisal",
    "• Price reduction conversation",
    "",
    "Drop the situation in one sentence and I’ll write it.",
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
      "Paste the exact sentence you’re about to say/write and I’ll clean it up safely.",
    ].join("\n");
  }

  if (t.includes("disclosure") || t.includes("material defect") || t.includes("seller disclosure")) {
    return [
      "Disclosure (high-level):",
      "• When in doubt, disclose — and document it.",
      "• Keep it factual, dated, and consistent with your state forms.",
      "• For legal interpretation, loop in your broker or an attorney.",
      "",
      "Tell me your state and the issue (one line) and I’ll suggest the safest phrasing (non-legal).",
    ].join("\n");
  }

  return [
    "Compliance mode:",
    "I can help you phrase things safely and professionally — but for legal calls, your broker/attorney is the final authority.",
    "Paste what you’re about to send and I’ll rewrite it clean.",
  ].join("\n");
}

/* ============================================================
   //#4A — Elena envelope (Quick win → move convo → soft convert)
============================================================ */
function buildElenaEnvelope({ intent, baseReply, userText, profileContext, agent, flags }) {
  const name = safeStr(profileContext?.first_name) || safeStr(profileContext?.full_name) || "";
  const hasProfile = !!(profileContext && profileContext.email);

  const flirtyOk = userInitiatedFlirty(userText); // still stays professional
  const smsLimit = Number.isFinite(flags?.smsLimit) ? flags.smsLimit : null;

  // --- BLUF (one-liner)
  let bluf = "Here’s the clean next move.";
  if (intent === "affordability_question") bluf = "Here’s the math-backed verdict and your next move.";
  if (intent === "script_request") bluf = "Here’s a ready-to-send script you can use immediately.";
  if (intent === "workflow_question") bluf = "Here’s a repeatable workflow you can run on every deal.";
  if (intent === "compliance_question") bluf = "Here’s the safe, professional way to handle that.";
  if (intent === "product_question") bluf = "Here’s what RealtySaSS does and how to use it right now.";
  if (intent === "profile_question") bluf = "Here’s what I see on your profile (or what I need to pull it).";

  // --- Next question (ONE crisp question)
  // Keep it minimal and aligned to intent.
  let nextQuestion = "What’s the one constraint that matters most here — timeline, budget/payment, or decision blocker?";
  if (intent === "script_request") {
    if (isGhostBehavior(userText)) nextQuestion = "One detail: what’s the last thing they said yes to (showing, lender call, listing) — so I aim the follow-up at the real friction?";
    else nextQuestion = "One detail: what’s the #1 thing they care about most (payment, location, layout) so I tailor the message?";
  } else if (intent === "workflow_question") {
    nextQuestion = "Is this buyer, seller, or investor — and where is it stuck (lead → showing → offer → inspection → appraisal → closing)?";
  } else if (intent === "product_question") {
    nextQuestion = "Are you trying to solve buyer follow-up, offer strategy, or timeline automation first?";
  } else if (intent === "compliance_question") {
    nextQuestion = "What’s the exact sentence you’re about to send? Paste it and I’ll rewrite it safely.";
  } else if (intent === "affordability_question") {
    nextQuestion = "Do you want the ‘cleanest path to GREEN’ (lower price / higher down / expenses cut / credit lift) or an offer strategy within your current numbers?";
  } else if (intent === "profile_question") {
    nextQuestion = "Want me to use your saved info to build a BuyerProfile workflow now — or do you want scripts first?";
  }

  // --- Soft conversion pivot + CTA (single CTA, unless ghost script itself needs 2-choice)
  // We DO NOT do “two-choice close” for conversion; that rule is for client scripts.
  let pivot = "";
  let cta = "";

  if (!hasProfile) {
    pivot =
      "Right now I can give you the move + the script. With an account, I can save this scenario, build your BuyerProfile timeline, and generate the follow-up sequence so you’re not restarting each time.";
    cta = "Create your account/login, then paste the situation again and I’ll pick up exactly here with a saved BuyerProfile.";
  } else {
    pivot =
      "Want this turned into a saved BuyerProfile? That’s where the magic scales: timeline checkpoints, tasks, scripts, and a clean plan you can reuse on every client.";
    cta = "Say “Build BuyerProfile” and tell me the market + timeline — I’ll generate the first version.";
  }

  // --- Tone line (optional tiny personality, but professional)
  const opener = name
    ? `Hey ${name}${flirtyOk ? " 😄" : ""} —`
    : `Hey${flirtyOk ? " 😄" : ""} —`;

  // --- Compose reply (human-readable)
  const replyParts = [];
  replyParts.push(opener);
  replyParts.push(`BLUF: ${bluf}`);
  replyParts.push("");
  replyParts.push(baseReply);

  replyParts.push("");
  replyParts.push(`Next question: ${nextQuestion}`);

  replyParts.push("");
  replyParts.push(pivot);
  replyParts.push(`CTA: ${cta}`);

  // If SMS limit requested AND the baseReply contains a quoted script, keep a single compact “SMS-ready” line at end
  if (smsLimit && smsLimit <= 600) {
    // Try to extract first quoted string for convenience
    const m = String(baseReply || "").match(/"([^"]{20,})"/);
    if (m && m[1]) {
      const sms = hardTrimToChars(m[1], smsLimit);
      replyParts.push("");
      replyParts.push(`SMS-ready (≤${smsLimit} chars): "${sms}"`);
    }
  }

  const reply = replyParts.join("\n");

  // --- Structured blocks for UI (HUD can render these later)
  const blocks = {
    bluf,
    next_question: nextQuestion,
    pivot,
    cta,
    sms_limit: smsLimit || null,
    has_profile: hasProfile,
  };

  return { reply, blocks };
}

/* ============================================================
   //#5 — Intent detection (simple + reliable)
============================================================ */
function detectIntent(text) {
  const t = String(text || "").toLowerCase();

  // affordability / payment / deal math
  if (
    t.includes("afford") ||
    t.includes("payment") ||
    t.includes("mortgage") ||
    t.includes("principal") ||
    t.includes("interest") ||
    t.includes("down payment") ||
    t.includes("downpayment") ||
    t.includes("pti") ||
    t.includes("housing cap") ||
    t.includes("debt to income") ||
    t.includes("dti")
  ) return { type: "affordability_question" };

  if (
    t.includes("my profile") ||
    t.includes("profile loaded") ||
    t.includes("who am i") ||
    (t.includes("my") && (t.includes("name") || t.includes("phone") || t.includes("email")))
  ) return { type: "profile_question" };

  if (
    t.includes("buyerbrief") ||
    t.includes("buyerprofile") ||
    t.includes("crm") ||
    t.includes("realtysass") ||
    t.includes("ask elena") ||
    t.includes("how does this work") ||
    t.includes("pricing") ||
    t.includes("subscription") ||
    t.includes("plans")
  ) return { type: "product_question" };

  if (
    t.includes("buyer workflow") ||
    t.includes("buyer process") ||
    t.includes("first-time buyer") ||
    t.includes("offer strategy") ||
    t.includes("under contract") ||
    t.includes("inspection") ||
    t.includes("appraisal") ||
    t.includes("closing") ||
    t.includes("listing workflow") ||
    t.includes("seller workflow") ||
    t.includes("listing strategy") ||
    t.includes("price reduction") ||
    t.includes("days on market") ||
    t.includes("stale listing") ||
    t.includes("investor") ||
    t.includes("flip") ||
    t.includes("buy and hold") ||
    t.includes("cash flow") ||
    t.includes("rental")
  ) return { type: "workflow_question" };

  if (
    t.includes("script") ||
    t.includes("text message") ||
    t.includes("sms") ||
    t.includes("follow up") ||
    t.includes("follow-up") ||
    t.includes("email") ||
    t.includes("call opener") ||
    t.includes("what do i say")
  ) return { type: "script_request" };

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
   //#6 — Agent-first flow helpers
============================================================ */
function getApiBaseFromEnvOrDefault() {
  const u = safeStr(process.env.URL);
  if (u) return u;
  const p = safeStr(process.env.DEPLOY_PRIME_URL);
  if (p) return p;
  return "https://realtysass.netlify.app";
}

async function callElenaAgent({ origin, payload }) {
  const base = getApiBaseFromEnvOrDefault();
  const url = `${base.replace(/\/$/, "")}/api/elena-agent`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forward-Origin": safeStr(origin) || "",
      },
      body: JSON.stringify(payload || {}),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, error: `Agent HTTP ${resp.status}`, data: data || null };
    }
    return { ok: true, error: null, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), data: null };
  }
}

function buildAffordabilityReplyFromAgent(agent) {
  const v = agent?.verdict || {};
  const m = agent?.mortgage || {};
  const q = agent?.quick || {};

  const status = safeStr(v.status) || "INSUFFICIENT";
  const grade = safeStr(v.grade) || "N/A";

  const lines = [];
  lines.push(`BLUF: **${status}** (Grade: **${grade}**)`);

  if (v.housingCap != null) lines.push(`• 30% housing cap: ${formatMoney(v.housingCap)}/mo`);
  if (m.all_in_monthly != null) lines.push(`• Est. all-in housing: ${formatMoney(m.all_in_monthly)}/mo`);
  if (v.residual != null) lines.push(`• Residual after expenses + housing: ${formatMoney(v.residual)}/mo`);

  if (q?.quick_max_price?.price_0_down) {
    lines.push("");
    lines.push("Quick rails (rule-of-thumb):");
    lines.push(`• Max price @ 0% down: ${formatMoney(q.quick_max_price.price_0_down)}`);
    if (q.quick_max_price.price_5_down) lines.push(`• Max price @ 5% down: ${formatMoney(q.quick_max_price.price_5_down)}`);
  }

  const next = agent?.next_action || null;
  if (next?.why) {
    lines.push("");
    lines.push(`Next move: ${safeStr(next.why)}`);
  }

  if (Array.isArray(agent?.missing_inputs) && agent.missing_inputs.length) {
    lines.push("");
    lines.push(`Missing inputs to tighten this: ${agent.missing_inputs.join(", ")}`);
  }

  const stateKey = safeStr(agent?.knowledge?.state_key);
  if (stateKey) {
    lines.push("");
    lines.push(`State loaded: ${stateKey}`);
  }

  return lines.join("\n");
}

/* ============================================================
   //#7 — Main handler
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

  const smsLimit = wantsSmsLimit(userText);

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
        license_state: safeStr(profile.license_state) || null,
        state: safeStr(profile.state) || null,
        market_state: safeStr(profile.market_state) || null,
      }
    : null;

  // ✅ Step 1: Call elena-agent FIRST
  const agentCall = await callElenaAgent({
    origin,
    payload: {
      email: email || null,
      question: userText,
      overrides: payload?.overrides && typeof payload.overrides === "object" ? payload.overrides : undefined,
      scenario: payload?.scenario && typeof payload.scenario === "object" ? payload.scenario : undefined,
      context: {
        ...(context || {}),
        profile: profileContext || contextProfile || null,
      },
      debug: payload?.debug === true,
    },
  });

  const agent = agentCall.ok ? agentCall.data : null;
  const intent = detectIntent(userText);

  /* ==========================================================
     //#7.1 — Deterministic: Affordability / Deal Math (agent-driven)
  ========================================================== */
  if (intent?.type === "affordability_question" && agent?.ok) {
    const baseReply = buildAffordabilityReplyFromAgent(agent);
    const env = buildElenaEnvelope({
      intent: "affordability_question",
      baseReply,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "affordability_question",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }

  /* ==========================================================
     //#7.2 — Deterministic: Profile
  ========================================================== */
  if (intent?.type === "profile_question") {
    let baseReply = "";
    if (!profileContext || !profileContext.email) {
      baseReply =
        "I can pull your profile instantly once your email is synced.\nSend your email (or load your profile in the shell) and I’ll greet you properly + use your saved info.";
    } else {
      const bits = [];
      bits.push(`I have: ${profileContext.full_name || "your profile"} on file.`);
      if (profileContext.phone) bits.push(`Phone: ${profileContext.phone}`);
      if (profileContext.mode) bits.push(`Mode: ${profileContext.mode}`);
      if (profileContext.license_state || profileContext.state || profileContext.market_state) {
        bits.push(`State: ${profileContext.license_state || profileContext.market_state || profileContext.state}`);
      }
      baseReply = bits.join("\n");
    }

    const env = buildElenaEnvelope({
      intent: "profile_question",
      baseReply,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "profile_question",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }

  /* ==========================================================
     //#7.3 — Deterministic: Product help
  ========================================================== */
  if (intent?.type === "product_question") {
    const baseReply = buildProductHelpReply(userText, agent);
    const env = buildElenaEnvelope({
      intent: "product_question",
      baseReply,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "product_question",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }

  /* ==========================================================
     //#7.4 — Deterministic: Workflows
  ========================================================== */
  if (intent?.type === "workflow_question") {
    const t = userText.toLowerCase();
    let kind = null;
    if (t.includes("listing") || t.includes("seller")) kind = "seller_workflow";
    else if (t.includes("investor") || t.includes("flip") || t.includes("rental") || t.includes("cash flow")) kind = "investor_workflow";
    else kind = "buyer_workflow";

    const baseReply = buildWorkflowReply(kind);
    const env = buildElenaEnvelope({
      intent: "workflow_question",
      baseReply,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "workflow_question",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }

  /* ==========================================================
     //#7.5 — Deterministic: Scripts
  ========================================================== */
  if (intent?.type === "script_request") {
    const t = userText.toLowerCase();
    let kind = "menu";

    // Ghost/no response = two-choice close allowed
    if (isGhostBehavior(userText) || t.includes("no response") || t.includes("not responding") || t.includes("ghost")) {
      kind = "followup_no_response";
    } else if (t.includes("showing") || t.includes("after we saw") || t.includes("post showing") || t.includes("after the showing")) {
      kind = "followup_after_showing";
    } else if (t.includes("offer") || t.includes("listing agent")) {
      kind = "buyer_offer_intro";
    } else if (t.includes("inspection") || t.includes("repairs")) {
      kind = "inspection_pushback";
    } else if (t.includes("price reduction") || t.includes("reduce") || t.includes("stale")) {
      kind = "seller_price_reality";
    }

    const baseReply = buildScriptReply(kind, context || {}, { smsLimit });
    const env = buildElenaEnvelope({
      intent: "script_request",
      baseReply,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "script_request",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }

  /* ==========================================================
     //#7.6 — Deterministic: Compliance guardrails
  ========================================================== */
  if (intent?.type === "compliance_question") {
    const baseReply = buildComplianceReply(userText);
    const env = buildElenaEnvelope({
      intent: "compliance_question",
      baseReply,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "compliance_question",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }

  /* ==========================================================
     //#7.7 — OpenAI fallback (optional) WITH agent packet
  ========================================================== */
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const who = profileContext?.full_name ? `I see you as ${profileContext.full_name}.` : "I don’t see your profile yet.";
    const baseReply = `Elena (dev echo): “${userText}” — ${who} Add OPENAI_API_KEY for natural-language answers, rewriting, and strategy.`;

    const env = buildElenaEnvelope({
      intent: "fallback_no_openai",
      baseReply,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "fallback_no_openai",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }

  const system = [
    "You are Elena, the RealtySaSS Realtor-side AI assistant and mentor.",
    "Tone: confident, warm, slightly daring, but professional. Never explicit.",
    "No pet names like 'baby' unless the user clearly initiates flirty tone.",
    "Style: Quick win first, BLUF-first, then bullets. Keep the conversation moving with ONE crisp next question.",
    "Always add a soft conversion pivot: account/login lets you save the scenario, build BuyerProfile timeline, and generate follow-up sequences.",
    "Two-choice close is ONLY for ghost/no-response scripts to clients.",
    "When user asks for a script: provide a ready-to-send version and respect any character limit request (default SMS <= 400).",
    "When user asks for a plan: give next 3 moves + what to ask for.",
    "If user asks for comps/prices: ask for location + 2–3 comparable anchors (you do not have MLS access).",
    "Compliance: avoid steering/discrimination; use safe wording; recommend broker/attorney for legal interpretation.",
    "Use the provided profile + context as truth. Use the agent packet as the factual baseline.",
    "If missing info, ask for only the minimum needed once.",
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
        max_tokens: 750,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              message: userText,
              profile: profileContext,
              context: context || null,
              agent_packet: agent || null,
              sms_limit: smsLimit || null,
              note:
                "Return a response that includes: BLUF, quick win, one crisp next question, and a soft conversion CTA.",
            }),
          },
        ],
      }),
    });

    const data = await resp.json();
    const replyRaw =
      (data?.choices?.[0]?.message?.content || "").trim() ||
      "I’m here. Tell me the deal situation in one sentence and what outcome you want.";

    // Wrap OpenAI reply inside Elena envelope lightly (so cadence stays consistent)
    const env = buildElenaEnvelope({
      intent: "openai_fallback",
      baseReply: replyRaw,
      userText,
      profileContext,
      agent,
      flags: { smsLimit },
    });

    return respond(200, headers, {
      intent: "openai_fallback",
      reply: env.reply,
      blocks: env.blocks,
      profile: profileContext || null,
      agent: agent || null,
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
        model: "gpt-4o-mini",
      },
    });
  } catch (err) {
    return respond(500, headers, {
      error: "Server exception",
      detail: String(err),
      debug: {
        usedSupabase,
        hasContextProfile: !!contextProfile,
        supabaseError: supabaseError || null,
        agentOk: agentCall.ok,
        agentError: agentCall.error || null,
      },
    });
  }
};
