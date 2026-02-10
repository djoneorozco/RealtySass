// netlify/functions/ask-elena.js
// ============================================================
// v3.3.0 — RealtySaSS • Ask Elena (Local Memory + Thread)
// ✅ NEW: context.thread + context.memory support
// ✅ NEW: returns memory_patch for HUD localStorage merge
// ✅ NEW: remembers simple picks (ex: number 1–10)
// ✅ Keeps replies short + conversational
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

function lastUserTurn(thread) {
  if (!Array.isArray(thread)) return "";
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i] && thread[i].role === "user") return safeStr(thread[i].content);
  }
  return "";
}

function lastAssistantTurn(thread) {
  if (!Array.isArray(thread)) return "";
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i] && thread[i].role === "assistant") return safeStr(thread[i].content);
  }
  return "";
}

/* ============================================================
   //#4 — Intent detection (with memory-aware follow-ups)
============================================================ */
function detectIntent(text, memory, thread) {
  const t = String(text || "").toLowerCase().trim();

  const isGreeting =
    /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))[\!\.\s,]*$/.test(t) ||
    /^(hi|hey|hello)\s+(elena|there)[\!\.\s,]*$/.test(t);

  if (isGreeting) return { type: "greeting" };

  // memory reset
  if (t === "/reset") return { type: "reset" };

  // number picker
  if (/(tell me|pick|choose).*(number).*(1|one).*(10|ten)/.test(t) || /number 1 to 10/.test(t)) {
    return { type: "pick_number_1_10" };
  }
  if (t.includes("what number did you") || t.includes("what number was it") || t.includes("which number")) {
    // if we have a number stored, treat as followup
    if (memory && typeof memory.last_number_1_10 === "number") return { type: "recall_number_1_10" };
    return { type: "recall_number_1_10_missing" };
  }

  // product / account
  if (t.includes("account") || t.includes("sign up") || t.includes("signup") || t.includes("login")) {
    return { type: "account_help" };
  }
  if (t.includes("buyerprofile") || t.includes("buyer profile") || t.includes("buyerbrief") || t.includes("realtysass")) {
    return { type: "product_question" };
  }

  // scripts / workflows
  if (t.includes("script") || t.includes("follow up") || t.includes("follow-up") || t.includes("text") || t.includes("email")) {
    return { type: "script_request" };
  }
  if (t.includes("workflow") || t.includes("process") || t.includes("offer") || t.includes("inspection") || t.includes("appraisal")) {
    return { type: "workflow_question" };
  }

  // conversational fallback: if user replies with a single word, treat it as continuation
  const short = t.split(/\s+/).filter(Boolean).length <= 2;
  if (short && thread && thread.length >= 2) {
    return { type: "continuation" };
  }

  return { type: "general" };
}

/* ============================================================
   //#5 — Deterministic replies (short + conversational)
============================================================ */
function replyGreeting(role) {
  if (role === "buyerbrief_brief") {
    return "Hey — where is your buyer in the timeline right now (pre-approval, touring, offer, under contract)?";
  }
  return "Hey — want a script, an offer move, or a workflow?";
}

function replyProduct(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("buyerprofile") || t.includes("buyer profile")) {
    return "BuyerProfile is your timeline-first buyer workspace. Tell me: are we building one new buyer, or updating an existing one?";
  }
  if (t.includes("buyerbrief")) {
    return "BuyerBrief™ is the realtor-facing, timeline-first briefing. Where is the client stuck right now?";
  }
  if (t.includes("realtysass")) {
    return "RealtySaSS helps you run cleaner deals: scripts, negotiation prep, workflows, and timeline-based next steps. Buyer, seller, or investor — what are you working on?";
  }
  return "Tell me what you want to do: script, offer move, or workflow — and I’ll keep it tight.";
}

function replyAccount() {
  // keep it practical, not vague
  return [
    "To create an account:",
    "1) Click your site’s “Join Us” / “Log In” button (top nav).",
    "2) Enter email → you’ll get a code → paste it to verify.",
    "3) Once you’re in, I can save your BuyerProfile/timeline so you don’t restart.",
    "",
    "If you tell me what page you’re on (Login, Pricing, BuyerProfile), I’ll guide the exact click path."
  ].join("\n");
}

function replyScriptMenu() {
  return "Pick one: lead follow-up, offer intro, inspection pushback, low appraisal, or price reduction convo.";
}

function replyWorkflowMenu() {
  return "Buyer, seller, or investor workflow?";
}

function replyContinuation(thread, memory) {
  const lastBot = lastAssistantTurn(thread);
  const lastTopic = safeStr(memory?.last_topic);

  // If Elena asked a question last, repeat it but shorter + one option
  if (lastBot && lastBot.includes("?")) {
    // tighten: last line with question mark
    const q = lastBot.split("\n").filter(l => l.includes("?")).slice(-1)[0] || "What are we working on?";
    return `${q} (One line answer is perfect.)`;
  }
  if (lastTopic) return `Got it — staying on ${lastTopic}. What’s the next detail you want me to handle?`;
  return "Got it. What’s the next detail?";
}

/* ============================================================
   //#6 — OpenAI fallback (optional) using thread
============================================================ */
async function openAIFallback({ userText, thread, memory, profile, role, maxChars }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return clampTextToChars("I’m missing OPENAI_API_KEY. Deterministic mode is on — tell me: script, offer move, or workflow?", maxChars);
  }

  const system = [
    "You are Elena, a Realtor-side assistant for RealtySaSS.",
    "Be conversational. Use the provided thread + memory so you remember context.",
    "CRITICAL: Keep replies short. Default <= 2 short paragraphs.",
    "No upsell unless user asked about account/login/pricing/saving/personalizing.",
    `Role: ${role || "public_mainpage"}. If role is buyerbrief_brief: timeline-only, no selling.`,
  ].join(" ");

  // build messages from thread (last 12)
  const msgs = [];
  msgs.push({ role: "system", content: system });

  const recent = Array.isArray(thread) ? thread.slice(-12) : [];
  recent.forEach((m) => {
    if (!m || !m.role || !m.content) return;
    const r = (m.role === "assistant") ? "assistant" : "user";
    msgs.push({ role: r, content: String(m.content) });
  });

  // current message
  msgs.push({ role: "user", content: userText });

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.35,
      max_tokens: 220,
      messages: [
        ...msgs,
        {
          role: "system",
          content: "Memory object (facts): " + JSON.stringify(memory || {}),
        },
      ],
    }),
  });

  const data = await resp.json();
  const out = (data?.choices?.[0]?.message?.content || "").trim() || "Got it. What’s the one constraint that matters most?";
  return clampTextToChars(out, maxChars);
}

/* ============================================================
   //#7 — Handler
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
  const role = safeStr(context.role) || "public_mainpage";

  const limits = safeObj(context.response_limits) || {};
  const MAX_CHARS = Number.isFinite(Number(limits.max_chars)) ? Number(limits.max_chars) : 420;
  const GREET_MAX = Number.isFinite(Number(limits.greeting_max_chars)) ? Number(limits.greeting_max_chars) : 160;

  // ✅ NEW: thread + memory from client
  const thread = Array.isArray(context.thread) ? context.thread : [];
  const memory = safeObj(context.memory) || {};
  const memory_patch = {};

  // profile lookup (optional)
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

  /* ============================
     //#7.1 Greeting (short)
  ============================ */
  if (intent.type === "greeting") {
    memory_patch.last_intent = "greeting";
    memory_patch.last_topic = memory.last_topic || "general";
    const reply = clampTextToChars(replyGreeting(role), GREET_MAX);
    return respond(200, headers, {
      intent: "greeting",
      reply,
      memory_patch,
      profile: profileContext,
      ui: { speed: 22, startDelay: 90 }
    });
  }

  /* ============================
     //#7.2 Pick number 1–10 (store)
  ============================ */
  if (intent.type === "pick_number_1_10") {
    const n = Math.floor(Math.random() * 10) + 1;
    memory_patch.last_number_1_10 = n;
    memory_patch.last_intent = "pick_number_1_10";
    const reply = clampTextToChars(`Sure — ${n}.`, MAX_CHARS);
    return respond(200, headers, { intent: "pick_number_1_10", reply, memory_patch, profile: profileContext });
  }

  /* ============================
     //#7.3 Recall number 1–10
  ============================ */
  if (intent.type === "recall_number_1_10") {
    const n = Number(memory.last_number_1_10);
    const reply = clampTextToChars(`I picked **${n}**.`, MAX_CHARS);
    memory_patch.last_intent = "recall_number_1_10";
    return respond(200, headers, { intent: "recall_number_1_10", reply, memory_patch, profile: profileContext });
  }
  if (intent.type === "recall_number_1_10_missing") {
    const reply = clampTextToChars("I don’t have it saved yet — ask me to pick a number 1–10 and I’ll remember it.", MAX_CHARS);
    return respond(200, headers, { intent: "recall_number_1_10_missing", reply, memory_patch, profile: profileContext });
  }

  /* ============================
     //#7.4 Account help
  ============================ */
  if (intent.type === "account_help") {
    memory_patch.last_topic = "account";
    memory_patch.last_intent = "account_help";
    const reply = clampTextToChars(replyAccount(), MAX_CHARS);
    return respond(200, headers, { intent: "account_help", reply, memory_patch, profile: profileContext });
  }

  /* ============================
     //#7.5 Product question
  ============================ */
  if (intent.type === "product_question") {
    const reply = clampTextToChars(replyProduct(userText), MAX_CHARS);
    memory_patch.last_topic = "product";
    memory_patch.last_intent = "product_question";
    return respond(200, headers, { intent: "product_question", reply, memory_patch, profile: profileContext });
  }

  /* ============================
     //#7.6 Script request
  ============================ */
  if (intent.type === "script_request") {
    const reply = clampTextToChars(replyScriptMenu(), MAX_CHARS);
    memory_patch.last_topic = "scripts";
    memory_patch.last_intent = "script_request";
    return respond(200, headers, { intent: "script_request", reply, memory_patch, profile: profileContext });
  }

  /* ============================
     //#7.7 Workflow question
  ============================ */
  if (intent.type === "workflow_question") {
    const reply = clampTextToChars(replyWorkflowMenu(), MAX_CHARS);
    memory_patch.last_topic = "workflow";
    memory_patch.last_intent = "workflow_question";
    return respond(200, headers, { intent: "workflow_question", reply, memory_patch, profile: profileContext });
  }

  /* ============================
     //#7.8 Continuation (memory-aware)
  ============================ */
  if (intent.type === "continuation") {
    const reply = clampTextToChars(replyContinuation(thread, memory), MAX_CHARS);
    memory_patch.last_intent = "continuation";
    return respond(200, headers, { intent: "continuation", reply, memory_patch, profile: profileContext });
  }

  /* ============================
     //#7.9 OpenAI fallback (thread-based)
  ============================ */
  try {
    const reply = await openAIFallback({
      userText,
      thread,
      memory,
      profile: profileContext,
      role,
      maxChars: MAX_CHARS
    });

    memory_patch.last_intent = "openai_fallback";
    // crude topic tracking
    if (/buyerprofile|buyer profile/i.test(userText)) memory_patch.last_topic = "buyerprofile";
    if (/offer/i.test(userText)) memory_patch.last_topic = "offer";
    if (/inspection/i.test(userText)) memory_patch.last_topic = "inspection";

    return respond(200, headers, {
      intent: "openai_fallback",
      reply,
      memory_patch,
      profile: profileContext
    });
  } catch (e) {
    const reply = clampTextToChars("I hit a hiccup. Try that again in one line — script, offer move, or workflow?", MAX_CHARS);
    return respond(200, headers, { intent: "error", reply, memory_patch, profile: profileContext });
  }
};
