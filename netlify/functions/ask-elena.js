// netlify/functions/ask-elena.js
// ============================================================
// v3.1.0 — RealtySaSS • Ask Elena (Realtor Mentor + SME)
// ✅ NEW FLOW:
//   1) Call /api/elena-agent FIRST (truth packet + knowledge)
//   2) If affordability/deal-math: deterministic reply from agent
//   3) Else: existing deterministic intents (workflow/scripts/compliance/product)
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

/* ============================================================
   //#4 — Deterministic replies (existing)
============================================================ */
function buildProductHelpReply(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("buyerbrief")) {
    return [
      "BuyerBrief™ is the timeline-first buyer workspace.",
      "Use it to capture milestones (pre-approval → showings → offer → option period → close), assign next steps, and keep everything organized for the client and your team.",
      "If you tell me where the deal is stuck (pre-approval, inventory, offer terms, repairs, appraisal), I’ll give you the next 3 moves and the exact message to send.",
    ].join("\n");
  }

  if (t.includes("crm")) {
    return [
      "RealtySaSS CRM is the pipeline + follow-up engine (when enabled in your stack).",
      "Think: stages, tasks, reminders, notes, and clean handoffs between buyer timeline + your pipeline.",
      "Tell me your current lead stage and timeframe, and I’ll write a follow-up sequence (text + email) that doesn’t sound desperate.",
    ].join("\n");
  }

  if (t.includes("ask elena") || t.includes("elena")) {
    return [
      "Ask Elena is your Realtor-side command center: quick answers, scripts, negotiation prep, client coaching, and deal triage.",
      "If you drop a situation + constraints (price point, timeline, financing type, inspection issues), I’ll give you a BLUF + a plan.",
    ].join("\n");
  }

  return [
    "RealtySaSS is built to help you move deals faster with less chaos:",
    "• Buyer/seller workflow checklists",
    "• Scripts (texts/emails/call openers)",
    "• Negotiation prep + risk flags",
    "• Deal triage (what to do next, what to ask for)",
    "",
    "Tell me what you’re working on (buyer, seller, investor) and what’s blocking the deal.",
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
      `"No problem. Want me to circle back next week, or later this month?"`,
    ].join("\n");
  }

  if (kind === "buyer_offer_intro") {
    return [
      "Offer Intro (Agent → Listing Agent):",
      `"Hey — I’m bringing you a clean offer on ${address}. ${buyerName} is motivated and we’re aiming for a smooth close. What matters most to your seller: price, timeline, or certainty?"`,
      "",
      "Follow-up if they say “certainty”:",
      `"Perfect — I’ll structure it to reduce friction and keep inspections tight. Any preferred title/lender or dates we should align to?"`,
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
      "• Price adjustment (if it’s structural/roof/HVAC)",
    ].join("\n");
  }

  if (kind === "seller_price_reality") {
    return [
      "Seller Pricing Reality Check (respectful, decisive):",
      `"Here’s the honest read: the market will tell us in the first 7 days. If we’re priced right, we’ll get strong traffic and at least one serious offer. If not, we adjust fast — not after we go stale."`,
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
      "Tell me your state and the issue (one line) and I’ll suggest the safest way to phrase it (non-legal).",
    ].join("\n");
  }

  return [
    "Compliance mode:",
    "I can help you phrase things safely and professionally — but for legal calls, your broker/attorney is the final authority.",
    "Paste what you’re about to send and I’ll rewrite it clean.",
  ].join("\n");
}

/* ============================================================
   //#5 — Intent detection (simple + reliable)
============================================================ */
function detectIntent(text) {
  const t = String(text || "").toLowerCase();

  // NEW: affordability / payment / deal math
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
  // Netlify provides URL/DEPLOY_PRIME_URL in many contexts
  const u = safeStr(process.env.URL);
  if (u) return u;
  const p = safeStr(process.env.DEPLOY_PRIME_URL);
  if (p) return p;

  // Fallback
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
        // Forward origin if you want it for logging; CORS is handled in function response anyway
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

  // State-specific nudge if loaded
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
        // ensure agent sees profile (even if Supabase missing)
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
    const reply = buildAffordabilityReplyFromAgent(agent);
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
      return respond(200, headers, {
        intent: "profile_question",
        reply:
          "I can pull your profile instantly once your email is synced. Send your email (or load your profile in the shell) and I’ll greet you properly + use your saved info.",
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
    bits.push(`Got you. I have: ${profileContext.full_name || "your profile"} on file.`);
    if (profileContext.phone) bits.push(`Phone: ${profileContext.phone}`);
    if (profileContext.mode) bits.push(`Mode: ${profileContext.mode}`);
    if (profileContext.license_state || profileContext.state || profileContext.market_state) {
      bits.push(`State: ${profileContext.license_state || profileContext.market_state || profileContext.state}`);
    }

    return respond(200, headers, {
      intent: "profile_question",
      reply: bits.join("\n"),
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
    const reply = buildProductHelpReply(userText);
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

    const reply = buildWorkflowReply(kind);
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

    if (t.includes("no response") || t.includes("ghost") || t.includes("follow up")) kind = "followup_no_response";
    if (t.includes("offer") || t.includes("listing agent")) kind = "buyer_offer_intro";
    if (t.includes("inspection") || t.includes("repairs")) kind = "inspection_pushback";
    if (t.includes("price reduction") || t.includes("reduce") || t.includes("stale")) kind = "seller_price_reality";

    const reply = buildScriptReply(kind, context || {});
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
    const reply = buildComplianceReply(userText);
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
    return respond(200, headers, {
      intent: "fallback_no_openai",
      reply: `Elena (dev echo): “${userText}” — ${who} Add OPENAI_API_KEY for natural-language answers, rewriting, and strategy.`,
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
    "Style: BLUF-first, then bullets. Actionable. No fluff.",
    "When user asks for a script: provide a ready-to-send version (text/email/call opener).",
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
        max_tokens: 700,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              message: userText,
              profile: profileContext,
              context: context || null,
              agent_packet: agent || null,
              note:
                "Give BLUF first. Then bullets. If you need info, ask for only the minimum missing inputs once.",
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
