// netlify/functions/ask-elena.js
// ============================================================
// v3.4.0 — RealtySaSS • Ask Elena
// ✅ Local Memory Support: context.thread + context.memory
// ✅ FIX: Recovers last_number_1_10 from thread if memory missing
// ✅ NEW: "remember 5" command stores the number
// ✅ Clean answers for product + pricing
// ============================================================

const { createClient } = require("@supabase/supabase-js");

/* ============================================================
   //#1 — CORS
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
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
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
   //#2 — Profile lookup columns
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
   //#3 — Helpers
============================================================ */
function safeStr(x) {
  const s = String(x ?? "").trim();
  return s || "";
}
function normalizeEmail(x) {
  return safeStr(x).toLowerCase();
}
function safeObj(x) {
  return x && typeof x === "object" ? x : null;
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

function lastAssistantTurn(thread) {
  if (!Array.isArray(thread)) return "";
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i] && thread[i].role === "assistant") return safeStr(thread[i].content);
  }
  return "";
}

function recoverNumberFromThread(thread) {
  // Looks for Elena saying: "Sure — 5." or "Sure —5."
  if (!Array.isArray(thread)) return null;
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (!m || m.role !== "assistant") continue;
    const txt = String(m.content || "");
    const match = txt.match(/sure\s*[—-]\s*(10|[1-9])\b/i);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n >= 1 && n <= 10) return n;
    }
  }
  return null;
}

/* ============================================================
   //#4 — Intent detection
============================================================ */
function detectIntent(text, memory, thread) {
  const t = String(text || "").toLowerCase().trim();

  const isGreeting =
    /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))[\!\.\s,]*$/.test(t) ||
    /^(hi|hey|hello)\s+(elena|there)[\!\.\s,]*$/.test(t);

  if (isGreeting) return { type: "greeting" };

  if (t === "/reset") return { type: "reset" };

  // remember N
  const rememberMatch = t.match(/^remember\s+(10|[1-9])\b/);
  if (rememberMatch) return { type: "remember_number_1_10", n: Number(rememberMatch[1]) };

  // pick number
  if (/(pick|choose).*(number).*(1|one).*(10|ten)/.test(t) || /number 1 to 10/.test(t)) {
    return { type: "pick_number_1_10" };
  }

  // recall number
  if (t.includes("what number did you") || t.includes("what number was it") || t.includes("which number")) {
    if (memory && typeof memory.last_number_1_10 === "number") return { type: "recall_number_1_10" };

    // recovery path: thread might contain the number
    const recovered = recoverNumberFromThread(thread);
    if (typeof recovered === "number") return { type: "recall_number_1_10_recovered", n: recovered };

    return { type: "recall_number_1_10_missing" };
  }

  // product/pricing
  if (t.includes("best product") || t.includes("how much") || t.includes("cost") || t.includes("pricing")) {
    return { type: "product_pricing" };
  }

  if (t.includes("buyerprofile") || t.includes("buyer profile") || t.includes("buyerbrief") || t.includes("realtysass")) {
    return { type: "product_question" };
  }

  if (t.includes("account") || t.includes("sign up") || t.includes("signup") || t.includes("login")) {
    return { type: "account_help" };
  }

  return { type: "general" };
}

/* ============================================================
   //#5 — Deterministic replies (short)
============================================================ */
function replyGreeting() {
  return "Hey — want a script, an offer move, or a workflow?";
}

function replyProduct() {
  return "RealtySaSS is built to keep deals clean: scripts, negotiation prep, workflows, and timeline-based next steps. Buyer, seller, or investor — who are we working on?";
}

function replyPricing() {
  // Current pricing snapshot from your locked-in plan
  return [
    "Best “core” product: **BuyerBrief™** (timeline-first buyer intelligence).",
    "",
    "Pricing:",
    "• Single: **$179**",
    "• Pro: **$249/mo** or **$2,200/yr**",
    "• Teams 5: **$699/mo** or **$6,700/yr**",
    "• Teams 10: **$1,200/mo** or **$11,500/yr**",
    "",
    "Tell me: solo agent or team — and do you want BuyerBrief or the CRM add-on?"
  ].join("\n");
}

function replyAccount() {
  return [
    "Account setup is quick:",
    "1) Tap **Join Us** (top nav).",
    "2) Enter email → get code → verify.",
    "3) You’re in — and I can save your timeline so you don’t repeat yourself.",
    "",
    "Which page are you on right now: Login, Pricing, or BuyerProfile?"
  ].join("\n");
}

/* ============================================================
   //#6 — Handler
============================================================ */
module.exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return respond(204, headers, {});
  if (event.httpMethod !== "POST") return respond(405, headers, { error: "Method Not Allowed" });

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch (_) { return respond(400, headers, { error: "Invalid JSON body" }); }

  const userText = safeStr(payload.message);
  if (!userText) return respond(400, headers, { error: "Missing message" });

  const context = safeObj(payload.context) || {};
  const limits = safeObj(context.response_limits) || {};
  const MAX_CHARS = Number.isFinite(Number(limits.max_chars)) ? Number(limits.max_chars) : 420;
  const GREET_MAX = Number.isFinite(Number(limits.greeting_max_chars)) ? Number(limits.greeting_max_chars) : 160;

  const thread = Array.isArray(context.thread) ? context.thread : [];
  const memory = safeObj(context.memory) || {};
  const memory_patch = {};

  // optional profile lookup
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const email = getEmailFromPayload(payload);

  let profile = null;
  if (email && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data } = await supabase
        .from("profiles")
        .select(SELECT_COLS)
        .eq("email", email)
        .maybeSingle();
      if (data) profile = data;
    } catch (_) {}
  }
  if (!profile && safeObj(context.profile)) profile = context.profile;

  const name = pickName(profile);
  const profileContext = profile ? {
    email: normalizeEmail(profile.email || email) || null,
    full_name: name.full || null,
    first_name: safeStr(profile.first_name) || name.first || null,
    last_name: safeStr(profile.last_name) || name.last || null,
  } : null;

  const intent = detectIntent(userText, memory, thread);

  // Greeting
  if (intent.type === "greeting") {
    memory_patch.last_intent = "greeting";
    const reply = clampTextToChars(replyGreeting(), GREET_MAX);
    return respond(200, headers, {
      ok: true,
      intent: "greeting",
      reply,
      memory_patch,
      // ✅ also send a full echo (HUD v2.2.1 will store this)
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext,
      ui: { speed: 22, startDelay: 90 }
    });
  }

  // Remember N
  if (intent.type === "remember_number_1_10") {
    const n = Number(intent.n);
    memory_patch.last_number_1_10 = n;
    memory_patch.last_intent = "remember_number_1_10";
    const reply = clampTextToChars(`Locked in — I’ll remember **${n}**.`, MAX_CHARS);
    return respond(200, headers, {
      ok: true,
      intent: "remember_number_1_10",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // Pick number 1–10
  if (intent.type === "pick_number_1_10") {
    const n = Math.floor(Math.random() * 10) + 1;
    memory_patch.last_number_1_10 = n;
    memory_patch.last_intent = "pick_number_1_10";
    const reply = clampTextToChars(`Sure — ${n}.`, MAX_CHARS);
    return respond(200, headers, {
      ok: true,
      intent: "pick_number_1_10",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // Recall number (normal)
  if (intent.type === "recall_number_1_10") {
    const n = Number(memory.last_number_1_10);
    memory_patch.last_intent = "recall_number_1_10";
    const reply = clampTextToChars(`I picked **${n}**.`, MAX_CHARS);
    return respond(200, headers, {
      ok: true,
      intent: "recall_number_1_10",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // Recall number (recovered from thread)
  if (intent.type === "recall_number_1_10_recovered") {
    const n = Number(intent.n);
    memory_patch.last_number_1_10 = n;
    memory_patch.last_intent = "recall_number_1_10_recovered";
    const reply = clampTextToChars(`I picked **${n}**.`, MAX_CHARS);
    return respond(200, headers, {
      ok: true,
      intent: "recall_number_1_10_recovered",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // Recall missing
  if (intent.type === "recall_number_1_10_missing") {
    const reply = clampTextToChars(
      "I don’t have it saved yet — say **“remember 5”** (or any 1–10) and I’ll keep it.",
      MAX_CHARS
    );
    return respond(200, headers, {
      ok: true,
      intent: "recall_number_1_10_missing",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // Product + pricing
  if (intent.type === "product_pricing") {
    memory_patch.last_intent = "product_pricing";
    const reply = clampTextToChars(replyPricing(), MAX_CHARS);
    return respond(200, headers, {
      ok: true,
      intent: "product_pricing",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // Product question
  if (intent.type === "product_question") {
    memory_patch.last_intent = "product_question";
    const reply = clampTextToChars(replyProduct(), MAX_CHARS);
    return respond(200, headers, {
      ok: true,
      intent: "product_question",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // Account help
  if (intent.type === "account_help") {
    memory_patch.last_intent = "account_help";
    const reply = clampTextToChars(replyAccount(), MAX_CHARS);
    return respond(200, headers, {
      ok: true,
      intent: "account_help",
      reply,
      memory_patch,
      memory_echo: { ...memory, ...memory_patch },
      profile: profileContext
    });
  }

  // General fallback (tight)
  memory_patch.last_intent = "general";
  const reply = clampTextToChars(
    "Got you. Pick one so I can be surgical: **script**, **offer move**, or **workflow**?",
    MAX_CHARS
  );

  return respond(200, headers, {
    ok: true,
    intent: "general",
    reply,
    memory_patch,
    memory_echo: { ...memory, ...memory_patch },
    profile: profileContext
  });
};
