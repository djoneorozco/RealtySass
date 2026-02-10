// netlify/functions/ask-elena.js
// ============================================================
// v3.2.0 — RealtySaSS • Ask Elena (Realtor Mentor + SME)
// ✅ Fix: greeting intent + short replies
// ✅ Fix: hard response length cap (chars)
// ✅ Fix: upsell only when relevant (account/pricing/save/personalize)
// ✅ Flow:
//   1) Call /api/elena-agent FIRST (truth packet + knowledge)
//   2) If affordability/deal-math: deterministic reply from agent
//   3) Else: deterministic intents (workflow/scripts/compliance/product/greeting)
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

function clampTextToChars(text, maxChars) {
  const s = String(text || "");
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return s;
  if (s.length <= n) return s;

  // Try to cut on a clean boundary
  const cut = s.slice(0, n);
  const lastBreak = Math.max(
    cut.lastIndexOf("\n"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? ")
  );

  const finalCut = (lastBreak > 120 ? cut.slice(0, lastBreak + 1) : cut).trim();
  return finalCut.replace(/\s+$/g, "") + "…";
}

/* ============================================================
   //#4 — Deterministic replies (existing)
============================================================ */
function buildProductHelpReply(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("buyerbrief")) {
    return [
      "BuyerBrief™ is the timeline-first buyer workspace.",
      "Capture milestones (pre-approval → showings → offer → option → close), assign next steps, and keep clients moving.",
      "Tell me where the deal is stuck and I’ll give your next 3 moves + the exact message to send.",
    ].join("\n");
  }

  if (t.includes("crm")) {
    return [
      "RealtySaSS CRM is your pipeline + follow-up engine.",
      "Stages, tasks, reminders, notes — clean handoffs from BuyerBrief to pipeline.",
      "Tell me the lead stage + timeline and I’ll write a follow-up sequence that doesn’t sound desperate.",
    ].join("\n");
  }

  if (t.includes("ask elena") || t.includes("elena")) {
    return [
      "Ask Elena is your Realtor-side command center: scripts, negotiation prep, deal triage, and workflow guidance.",
      "Drop a situation + constraints and I’ll give a BLUF + a clean plan.",
    ].join("\n");
  }

  return [
    "RealtySaSS helps you move deals faster with less chaos:",
    "• Buyer/seller workflows",
    "• Scripts (text/email/call openers)",
    "• Negotiation prep + risk flags",
    "• Deal triage (what to do next)",
    "",
    "Tell me: buyer, seller, or investor — and what’s blocking the deal?",
  ].join("\n");
}

function buildWorkflowReply(kind) {
  if (kind === "buyer_workflow") {
    return [
      "Buyer Workflow (clean + repeatable):",
      "1) Intake: timeline, must-haves, budget ceiling, financing type.",
      "2) Pre-approval: comfort payment (not just max approval).",
      "3) Search rules: areas, commute, deal-breakers.",
      "4) Showings: batch 5–8, same-day notes, rank top 3.",
      "5) Offer plan: comps, concessions, inspection posture.",
      "6) Option/inspection: health/safety + big-ticket first.",
      "7) Appraisal plan: comp packet + Plan B.",
      "8) Clear-to-close: repairs, utilities, walk-through, funds verified.",
    ].join("\n");
  }

  if (kind === "seller_workflow") {
    return [
      "Listing Workflow (win the week):",
      "1) Positioning: target buyer + value story.",
      "2) Prep: light fixes, lighting, curb pop, clean.",
      "3) Pricing: comp set + plan for first 7 days.",
      "4) Media: photos first, then copy.",
      "5) Launch: showing windows + offer rules.",
      "6) Negotiate: net + certainty + timeline.",
      "7) Under contract: inspections + repair strategy + backup posture.",
    ].join("\n");
  }

  if (kind === "investor_workflow") {
    return [
      "Investor Workflow (don’t get cute, get paid):",
      "1) Define target: hold vs flip vs mid-term.",
      "2) Underwrite: rent comps, taxes/ins/HOA, repairs, reserves.",
      "3) Exit plan: resale comps + DOM reality.",
      "4) Offer terms: speed + certainty + inspection posture.",
      "5) Execute: scope discipline + timeline + buffer.",
    ].join("\n");
  }

  return "Tell me if this is buyer, seller, or investor — I’ll drop the exact workflow.";
}

function buildScriptReply(kind, context) {
  const buyerName = safeStr(context?.buyer?.name) || "your buyer";
  const address = safeStr(context?.listing?.address) || "the property";
  const issue = safeStr(context?.issue) || "";

  if (kind === "followup_no_response") {
    return [
      "Text (no response):",
      `"Quick ping — still want me to line up options this week, or should I pause for now?"`,
      "",
      "If they say “pause”:",
      `"No problem. Want me to circle back next week or later this month?"`,
    ].join("\n");
  }

  if (kind === "buyer_offer_intro") {
    return [
      "Offer Intro (Agent → Listing Agent):",
      `"Hey — I’m bringing you a clean offer on ${address}. ${buyerName} is motivated and we’re aiming for a smooth close. What matters most to your seller: price, timeline, or certainty?"`,
      "",
      "If they say “certainty”:",
      `"Perfect — I’ll keep inspections tight and reduce friction. Any preferred dates/title/lender?"`,
    ].join("\n");
  }

  if (kind === "inspection_pushback") {
    return [
      "Inspection Pushback (calm + firm):",
      `"Totally get it. We’re not nickel-and-diming — we’re focused on health/safety + big-ticket items that affect financing. If we address these, we can keep the deal on track."`,
      issue ? `\n"Specifically: ${issue}"` : "",
      "",
      "Options:",
      "• Repair by licensed pro + receipt",
      "• Credit at closing",
      "• Price adjustment (roof/HVAC/structural)",
    ].join("\n");
  }

  if (kind === "seller_price_reality") {
    return [
      "Seller Pricing Reality Check:",
      `"The market will tell us in the first 7 days. If we’re priced right, we’ll get traffic and offers. If not, we adjust fast — not after we go stale."`,
      "",
      `"I’d rather price to win than chase the market down."`,
    ].join("\n");
  }

  return [
    "Tell me what you need a script for:",
    "• Lead follow-up",
    "• Offer intro",
    "• Inspection negotiation",
    "• Low appraisal",
    "• Price reduction convo",
    "",
    "Drop the situation in one sentence and I’ll write it.",
  ].join("\n");
}

function buildComplianceReply(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("fair housing") || t.includes("protected class") || t.includes("discrimination")) {
    return [
      "Fair Housing guardrails (high-level):",
      "• Talk property features + objective criteria — not people.",
      "• Avoid steering language.",
      "• Redirect protected-class requests to neutral criteria and let them choose.",
      "",
      "Paste what you’re about to send and I’ll rewrite it safely.",
    ].join("\n");
  }

  if (t.includes("disclosure") || t.includes("material defect") || t.includes("seller disclosure")) {
    return [
      "Disclosure (high-level):",
      "• When in doubt, disclose — and document it.",
      "• Keep it factual and consistent with state forms.",
      "• Broker/attorney is final authority for legal interpretation.",
      "",
      "Tell me your state + the issue and I’ll suggest safe phrasing (non-legal).",
    ].join("\n");
  }

  return [
    "Compliance mode:",
    "I can help you phrase things safely — broker/attorney is final authority for legal calls.",
    "Paste what you’re about to send and I’ll rewrite it clean.",
  ].join("\n");
}

/* ============================================================
   //#5 — Intent detection (simple + reliable)
============================================================ */
function detectIntent(text) {
  const t = String(text || "").toLowerCase().trim();

  // ✅ NEW: greeting intent (SHORT)
  const isGreeting =
    /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))[\!\.\s,]*$/.test(t) ||
    /^(hi|hey|hello)\s+(elena|there)[\!\.\s,]*$/.test(t);

  if (isGreeting) return { type: "greeting" };

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
    t.includes("crm") ||
    t.includes("realtysass") ||
    t.includes("ask elena") ||
    t.includes("how does this work") ||
    t.includes("pricing") ||
    t.includes("subscription")
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

function formatMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "$0";
  return x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
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

function buildGreetingReply(context) {
  // Ultra short: 1–2 lines + 1 question
  const role = safeStr(context?.role) || "public_mainpage";
  if (role === "buyerbrief_brief") {
    return "Hey — I’m Elena. Where is your buyer in the timeline right now (pre-approval, touring, offer, under contract)?";
  }
  return "Hey — I’m Elena. Want a script, an offer move, or a workflow?";
}

function shouldAllowAccountNudge(text, context) {
  const t = String(text || "").toLowerCase();
  const role = safeStr(context?.role) || "";
  if (role === "buyerbrief_brief") return false; // ✅ no selling in Brief mode

  return (
    t.includes("pricing") ||
    t.includes("subscription") ||
    t.includes("account") ||
    t.includes("sign up") ||
    t.includes("signup") ||
    t.includes("login") ||
    t.includes("save") ||
    t.includes("personalize") ||
    t.includes("buyerprofile") ||
    t.includes("buyer brief") ||
    t.includes("buyerbrief")
  );
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

  const context = payload?.context && typeof payload.context === "object" ? payload.context : {};
  const contextProfile =
    context?.profile && typeof context.profile === "object" ? context.profile : null;

  // response limits (from widget)
  const limits = (context?.response_limits && typeof context.response_limits === "object") ? context.response_limits : {};
  const MAX_CHARS = Number.isFinite(Number(limits.max_chars)) ? Number(limits.max_chars) : 420;
  const GREET_MAX = Number.isFinite(Number(limits.greeting_max_chars)) ? Number(limits.greeting_max_chars) : 160;

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

  // ✅ Step 1: Call elena-agent FIRST (safe to call; it can still return knowledge packet)
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
     //#7.0 — Deterministic: Greeting (SHORT)
  ========================================================== */
  if (intent?.type === "greeting") {
    const reply = clampTextToChars(buildGreetingReply(context), GREET_MAX);
    return respond(200, headers, {
      intent: "greeting",
      reply,
      profile: profileContext || null,
      agent: agent || null,
      ui: { speed: 22, startDelay: 90 },
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
     //#7.1 — Deterministic: Affordability / Deal Math (agent-driven)
  ========================================================== */
  if (intent?.type === "affordability_question" && agent?.ok) {
    let reply = buildAffordabilityReplyFromAgent(agent);
    reply = clampTextToChars(reply, MAX_CHARS);
    return respond(200, headers, {
      intent: "affordability_question",
      reply,
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
    if (!profileContext || !profileContext.email) {
      const reply = clampTextToChars(
        "I can greet you properly once your email is synced. Drop your email (or log in) and I’ll pull your saved profile.",
        MAX_CHARS
      );
      return respond(200, headers, {
        intent: "profile_question",
        reply,
        profile: null,
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

    const bits = [];
    bits.push(`Got you — I see ${profileContext.full_name || "your profile"} on file.`);
    if (profileContext.phone) bits.push(`Phone: ${profileContext.phone}`);
    if (profileContext.mode) bits.push(`Mode: ${profileContext.mode}`);

    const reply = clampTextToChars(bits.join("\n"), MAX_CHARS);

    return respond(200, headers, {
      intent: "profile_question",
      reply,
      profile: profileContext,
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
    let reply = buildProductHelpReply(userText);

    // Optional nudge ONLY if user asked for it
    if (shouldAllowAccountNudge(userText, context)) {
      reply += "\n\nIf you want, create an account so I can save your workflow/timeline and personalize scripts to your market.";
    }

    reply = clampTextToChars(reply, MAX_CHARS);

    return respond(200, headers, {
      intent: "product_question",
      reply,
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

    let reply = buildWorkflowReply(kind);
    reply = clampTextToChars(reply, MAX_CHARS);

    return respond(200, headers, {
      intent: "workflow_question",
      reply,
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

    if (t.includes("no response") || t.includes("ghost") || t.includes("follow up") || t.includes("follow-up")) kind = "followup_no_response";
    if (t.includes("offer") || t.includes("listing agent")) kind = "buyer_offer_intro";
    if (t.includes("inspection") || t.includes("repairs")) kind = "inspection_pushback";
    if (t.includes("price reduction") || t.includes("reduce") || t.includes("stale")) kind = "seller_price_reality";

    let reply = buildScriptReply(kind, context || {});
    reply = clampTextToChars(reply, MAX_CHARS);

    return respond(200, headers, {
      intent: "script_request",
      reply,
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
    let reply = buildComplianceReply(userText);
    reply = clampTextToChars(reply, MAX_CHARS);

    return respond(200, headers, {
      intent: "compliance_question",
      reply,
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
    const reply = clampTextToChars(
      `Elena (dev echo): “${userText}” — ${who} Add OPENAI_API_KEY for natural-language answers.`,
      MAX_CHARS
    );

    return respond(200, headers, {
      intent: "fallback_no_openai",
      reply,
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

  // Tight system: short by default + no sales unless asked
  const system = [
    "You are Elena, the RealtySaSS Realtor-side AI assistant and mentor.",
    "Tone: confident, warm, slightly daring, professional. Never explicit.",
    "CRITICAL: Keep replies short by default (<= 2 short paragraphs).",
    `CRITICAL: Aim for <= ${MAX_CHARS} characters unless the user explicitly asks for more detail.`,
    "If user greets, respond in ONE line and ask ONE question.",
    "No upsell unless user asks about pricing/account/login/saving/personalizing/BuyerProfile/BuyerBrief.",
    "If user asks for a script: provide a ready-to-send version.",
    "If user asks for a plan: give next 3 moves.",
    "Compliance: avoid steering/discrimination; recommend broker/attorney for legal interpretation.",
    "Use agent packet as factual baseline when present.",
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
        temperature: 0.35,
        max_tokens: 220, // ✅ keeps it tight
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              message: userText,
              profile: profileContext,
              context: context || null,
              agent_packet: agent || null,
              note: "Be short. One question max if needed.",
            }),
          },
        ],
      }),
    });

    const data = await resp.json();
    let reply =
      (data?.choices?.[0]?.message?.content || "").trim() ||
      "Got it. What are you trying to solve: script, offer, objection, or workflow?";

    reply = clampTextToChars(reply, MAX_CHARS);

    return respond(200, headers, {
      intent: "openai_fallback",
      reply,
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
