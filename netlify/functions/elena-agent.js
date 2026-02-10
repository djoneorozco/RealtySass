// netlify/functions/elena-agent.js
// ============================================================
// v2.2.0 — RealtySaSS • Agentic Elena (Orchestrator)
//
// ✅ Adds deterministic knowledge loading:
// - netlify/functions/data/ask-elena-realestate-basics.json
// - netlify/functions/data/realtysass.json
// - netlify/functions/data/states-<state>.json  (ex: states-texas.json)
//
// ✅ Output includes:
// - knowledge: { basics, state, realtysass }      (so Ask-Elena can narrate or render)
// - knowledge_used: receipt info (file names, load ok, errors)
//
// ============================================================

/* eslint-disable no-console */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

// ------------------------------
// //#1 CORS + ORIGIN CONTROL
// ------------------------------
const DEFAULT_ALLOW_ORIGINS = [
  "https://realtysass.com",
  "https://www.realtysass.com",
  "https://realtysass.netlify.app",

  // Webflow staging (optional)
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
  const allowOrigin = ALLOW_ORIGINS.includes(o) ? o : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function respond(statusCode, payload, origin) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(payload || {}),
  };
}

// ------------------------------
// //#2 HELPERS
// ------------------------------
function safeJsonParse(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function safeStr(x) {
  const s = String(x ?? "").trim();
  return s || "";
}

function normalizeEmail(emailRaw) {
  const e = String(emailRaw || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return "";
  return e;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return n;
  return Math.max(lo, Math.min(hi, n));
}

function roundTo(n, step) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n / step) * step;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function makeScenarioId(email, ts) {
  const h = crypto
    .createHash("sha256")
    .update(String(email || "") + ":" + String(ts))
    .digest("hex");
  return "elena_" + h.slice(0, 16);
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (
      v !== undefined &&
      v !== null &&
      v !== "" &&
      !(typeof v === "number" && !Number.isFinite(v))
    ) return v;
  }
  return null;
}

function hasPositiveMoney(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0;
}

function pickName(profile) {
  const full = safeStr(profile?.full_name);
  const first = safeStr(profile?.first_name);
  const last = safeStr(profile?.last_name);

  if (full) return { full, first: first || full.split(/\s+/)[0] || "", last: last || "" };
  if (first || last) return { full: `${first} ${last}`.trim(), first, last };
  return { full: "", first: "", last: "" };
}

// ------------------------------
// //#2A STATE NORMALIZATION + KNOWLEDGE LOADER
// ------------------------------
const DATA_DIR = path.join(__dirname, "data");
const BASICS_FILENAME = "ask-elena-realestate-basics.json";
const REALTYSASS_FILENAME = "realtysass.json";

// Cache across warm invocations
let __BASICS_CACHE = null;
let __REALTYSASS_CACHE = null;
const __STATE_CACHE = new Map();

const STATE_ALIASES = {
  tx: "texas",
  az: "arizona",
  ca: "california",
  fl: "florida",
  ny: "new-york",
  nj: "new-jersey",
  il: "illinois",
  wa: "washington",
  or: "oregon",
  co: "colorado",
  nv: "nevada",
  ga: "georgia",
  nc: "north-carolina",
  sc: "south-carolina",
  va: "virginia",
  md: "maryland",
  pa: "pennsylvania",

  "new york": "new-york",
  "new jersey": "new-jersey",
  "north carolina": "north-carolina",
  "south carolina": "south-carolina",
};

function normalizeStateKey(raw) {
  const s0 = safeStr(raw).toLowerCase();
  if (!s0) return "";

  if (/^[a-z]{2}$/.test(s0) && STATE_ALIASES[s0]) return STATE_ALIASES[s0];

  const cleaned = s0.replace(/[_\s]+/g, "-").replace(/[^a-z-]/g, "");
  if (!cleaned) return "";

  if (STATE_ALIASES[cleaned]) return STATE_ALIASES[cleaned];

  return cleaned;
}

function readJsonFileAbs(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  return JSON.parse(raw);
}

function loadBasics() {
  if (__BASICS_CACHE) {
    return { ok: true, file: BASICS_FILENAME, data: __BASICS_CACHE, error: null, cached: true };
  }

  const abs = path.join(DATA_DIR, BASICS_FILENAME);
  try {
    const data = readJsonFileAbs(abs);
    __BASICS_CACHE = data;
    return { ok: true, file: BASICS_FILENAME, data, error: null, cached: false };
  } catch (e) {
    return {
      ok: false,
      file: BASICS_FILENAME,
      data: null,
      error: `Failed to load ${BASICS_FILENAME}: ${String(e?.message || e)}`,
      cached: false,
    };
  }
}

function loadRealtySaSS() {
  if (__REALTYSASS_CACHE) {
    return { ok: true, file: REALTYSASS_FILENAME, data: __REALTYSASS_CACHE, error: null, cached: true };
  }

  const abs = path.join(DATA_DIR, REALTYSASS_FILENAME);
  try {
    const data = readJsonFileAbs(abs);
    __REALTYSASS_CACHE = data;
    return { ok: true, file: REALTYSASS_FILENAME, data, error: null, cached: false };
  } catch (e) {
    return {
      ok: false,
      file: REALTYSASS_FILENAME,
      data: null,
      error: `Failed to load ${REALTYSASS_FILENAME}: ${String(e?.message || e)}`,
      cached: false,
    };
  }
}

function loadState(stateKey) {
  const key = normalizeStateKey(stateKey);
  if (!key) {
    return { ok: false, key: "", file: null, data: null, error: "No state provided.", cached: false };
  }

  if (__STATE_CACHE.has(key)) {
    return { ok: true, key, file: `states-${key}.json`, data: __STATE_CACHE.get(key), error: null, cached: true };
  }

  const filename = `states-${key}.json`;
  const abs = path.join(DATA_DIR, filename);

  try {
    const data = readJsonFileAbs(abs);
    __STATE_CACHE.set(key, data);
    return { ok: true, key, file: filename, data, error: null, cached: false };
  } catch (e) {
    return {
      ok: false,
      key,
      file: filename,
      data: null,
      error: `Failed to load ${filename}: ${String(e?.message || e)}`,
      cached: false,
    };
  }
}

function resolveStateFromInputs({ body, profile, contextProfile }) {
  const o = body?.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const ctx = body?.context && typeof body.context === "object" ? body.context : {};
  const scenario = body?.scenario && typeof body.scenario === "object" ? body.scenario : {};

  return (
    pickFirst(
      o.state,
      o.license_state,
      ctx.state,
      ctx?.profile?.license_state,
      ctx?.profile?.state,
      contextProfile?.license_state,
      contextProfile?.state,
      profile?.license_state,
      profile?.state,
      profile?.market_state,
      scenario.state
    ) || ""
  );
}

// ------------------------------
// //#2B QUESTION PARSERS (DETERMINISTIC)
// ------------------------------
function parseHypotheticalCreditScoreFromQuestion(question) {
  const t = String(question || "").toLowerCase().trim();
  if (!t) return null;

  const looksHypothetical =
    /\bif\b|\bwent\s*up\b|\braise\b|\bbump\b|\bincrease\b|\bimprove\b|\bup\s*to\b|\bto\s*\d{3}\b/.test(t);

  if (!looksHypothetical) return null;

  const m =
    t.match(/(?:credit\s*score|fico)\D{0,12}(\d{3})\b/) ||
    t.match(/\bto\D{0,4}(\d{3})\b/);

  if (!m) return null;

  const s = Number(m[1]);
  if (!Number.isFinite(s)) return null;
  if (s < 300 || s > 850) return null;

  return Math.round(s);
}

// ------------------------------
// //#2C FINANCE MATH (DETERMINISTIC)
// ------------------------------
function aprTierFromScore(score) {
  const s = Number.isFinite(score) ? score : null;
  if (!s) return 0.070;
  if (s >= 780) return 0.0625;
  if (s >= 740) return 0.0675;
  if (s >= 700) return 0.0725;
  if (s >= 660) return 0.0800;
  return 0.0900;
}

function pmtMonthlyPI(principal, apr, termYears) {
  if (!Number.isFinite(principal) || principal <= 0) return null;
  const y = Number.isFinite(termYears) ? termYears : 30;
  const n = Math.round(y * 12);
  const r = (Number.isFinite(apr) ? apr : 0.07) / 12;
  if (n <= 0) return null;

  if (r <= 0) return principal / n;

  const pow = Math.pow(1 + r, n);
  const p = (principal * (r * pow)) / (pow - 1);
  return Number.isFinite(p) ? p : null;
}

function principalFromPmt(targetPI, apr, termYears) {
  if (!Number.isFinite(targetPI) || targetPI <= 0) return null;
  const y = Number.isFinite(termYears) ? termYears : 30;
  const n = Math.round(y * 12);
  const r = (Number.isFinite(apr) ? apr : 0.07) / 12;
  if (n <= 0) return null;

  if (r <= 0) return targetPI * n;

  const pow = Math.pow(1 + r, n);
  const principal = (targetPI * (pow - 1)) / (r * pow);
  return Number.isFinite(principal) ? principal : null;
}

function estimateAllInHousing({
  price,
  downpayment,
  creditScore,
  termYears,
  taxRate,
  insuranceAnnual,
  hoaMonthly,
}) {
  const P = Number(price);
  const D = Number(downpayment);
  const s = Number(creditScore);
  const y = Number.isFinite(termYears) ? termYears : 30;

  if (!Number.isFinite(P) || P <= 0) return { ok: false, reason: "Missing or invalid price." };
  if (!Number.isFinite(D) || D < 0) return { ok: false, reason: "Missing or invalid downpayment." };
  if (!Number.isFinite(s) || s < 300 || s > 850) return { ok: false, reason: "Missing or invalid creditScore." };

  const loan = Math.max(0, P - D);
  const apr = aprTierFromScore(s);
  const pi = pmtMonthlyPI(loan, apr, y);

  if (!Number.isFinite(pi) || pi <= 0) return { ok: false, reason: "Unable to compute P&I." };

  const used = {
    taxRate: Number.isFinite(taxRate) ? taxRate : 0.020,
    insuranceAnnual: Number.isFinite(insuranceAnnual) ? insuranceAnnual : 2400,
    hoaMonthly: Number.isFinite(hoaMonthly) ? hoaMonthly : 0,
  };

  const taxesMonthly = (P * used.taxRate) / 12;
  const insMonthly = used.insuranceAnnual / 12;
  const hoa = used.hoaMonthly;

  const allIn = pi + taxesMonthly + insMonthly + hoa;

  return {
    ok: true,
    apr_assumed: apr,
    loan_amount: Math.round(loan),
    term_years: y,
    breakdown: {
      principal_interest: Math.round(pi),
      taxes: Math.round(taxesMonthly),
      insurance: Math.round(insMonthly),
      hoa: Math.round(hoa),
    },
    all_in_monthly: Math.round(allIn),
    assumptions_used: used,
  };
}

function buildQuickAffordability({
  income,
  housingCapPct = 0.30,
  buffer = 1.28,
  apr,
  termYears = 30,
}) {
  const inc = Number.isFinite(income) ? income : null;
  if (!inc) return null;

  const housingCap = inc * housingCapPct;
  const piTarget = housingCap / buffer;

  const principal0 = principalFromPmt(piTarget, apr, termYears);
  const price0 = principal0 ? principal0 : null;
  const price5 = principal0 ? principal0 / 0.95 : null;

  return {
    housing_cap_monthly: Math.round(housingCap),
    pi_target_monthly: Math.round(piTarget),
    assumptions: {
      housing_cap_pct: housingCapPct,
      buffer,
      apr_assumed: Number.isFinite(apr) ? apr : null,
      term_years: termYears,
    },
    quick_max_price: {
      price_0_down: price0 ? Math.round(price0) : null,
      price_5_down: price5 ? Math.round(price5) : null,
    },
  };
}

// ------------------------------
// //#3 FAD SNAPSHOT INGEST (REALTYSaSS)
// ------------------------------
function readFadSnapshot(body) {
  const ctx = body?.context && typeof body.context === "object" ? body.context : {};
  const fad =
    (ctx?.fad && typeof ctx.fad === "object" ? ctx.fad : null) ||
    (body?.fad && typeof body.fad === "object" ? body.fad : null) ||
    (body?.fad_snapshot && typeof body.fad_snapshot === "object" ? body.fad_snapshot : null) ||
    (body?.snapshot && typeof body.snapshot === "object" ? body.snapshot : null) ||
    null;

  if (!fad) return {};

  return {
    __raw: fad,
    price: num(pickFirst(fad.price, fad.homePrice, fad.projected_home_price, fad.housingPrice)),
    expenses: num(pickFirst(fad.expenses, fad.monthlyExpenses, fad.monthly_expenses, fad.expenses_total)),
    downpayment: num(pickFirst(fad.downpayment, fad.dpAmt, fad.down, fad.currentSavings, fad.savings)),
    creditScore: num(pickFirst(fad.creditScore, fad.credit_score, fad.score, fad.scoreValue)),
    termYears: num(pickFirst(fad.termYears, fad.term_years, fad.term)),
    loanType: String(pickFirst(fad.loanType, fad.loan_type, fad.mortgageType) || "").toLowerCase() || null,
    income: num(pickFirst(fad.income, fad.monthlyIncome, fad.monthly_income, fad.totalIncome)),
    taxRate: num(pickFirst(fad.taxRate, fad.tax_rate)),
    insuranceAnnual: num(pickFirst(fad.insuranceAnnual, fad.insurance_annual)),
    hoaMonthly: num(pickFirst(fad.hoaMonthly, fad.hoa_monthly)),
  };
}

function buildScenario(body) {
  const scenario = body?.scenario && typeof body.scenario === "object" ? body.scenario : {};
  const overrides = body?.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const ctx = body?.context && typeof body.context === "object" ? body.context : {};
  const fad = readFadSnapshot(body);

  const question = safeStr(body?.question) || safeStr(body?.message) || safeStr(body?.prompt) || null;

  const price = num(pickFirst(overrides.price, fad.price, scenario.price, scenario.homePrice));
  const expenses = num(pickFirst(overrides.expenses, fad.expenses, scenario.expenses, scenario.monthlyExpenses));
  const downpayment = num(pickFirst(overrides.downpayment, fad.downpayment, scenario.downpayment, scenario.dpAmt));
  const income = num(pickFirst(overrides.income, fad.income, scenario.income, scenario.monthlyIncome));

  let creditScoreSource = "missing";
  const creditScoreRaw = num(pickFirst(overrides.creditScore, fad.creditScore, scenario.creditScore, scenario.score));
  let creditScore = creditScoreRaw ? clamp(Math.round(creditScoreRaw), 300, 850) : null;

  if (creditScore !== null) {
    if (overrides.creditScore !== undefined && overrides.creditScore !== null) creditScoreSource = "overrides";
    else if (fad.creditScore !== undefined && fad.creditScore !== null) creditScoreSource = "fad";
    else if (scenario.creditScore !== undefined && scenario.creditScore !== null) creditScoreSource = "scenario";
    else creditScoreSource = "scenario/overrides";
  } else {
    const fromQ = parseHypotheticalCreditScoreFromQuestion(question);
    if (fromQ !== null) {
      creditScore = fromQ;
      creditScoreSource = "question_hypothetical";
    }
  }

  const termYearsRaw = num(pickFirst(overrides.termYears, fad.termYears, scenario.termYears));
  const termYears = termYearsRaw ? clamp(Math.round(termYearsRaw), 10, 40) : 30;

  const loanType = String(
    pickFirst(overrides.loanType, fad.loanType, scenario.loanType, "conv") || "conv"
  ).toLowerCase();

  const taxRate = num(pickFirst(overrides.taxRate, fad.taxRate, scenario.taxRate));
  const insuranceAnnual = num(pickFirst(overrides.insuranceAnnual, fad.insuranceAnnual, scenario.insuranceAnnual));
  const hoaMonthly = num(pickFirst(overrides.hoaMonthly, fad.hoaMonthly, scenario.hoaMonthly));

  const contextProfile = ctx?.profile && typeof ctx.profile === "object" ? ctx.profile : null;

  return {
    question,
    overrides,
    baseline: scenario,
    fad,
    contextProfile,

    price,
    expenses,
    downpayment,
    creditScore,
    creditScoreSource,
    termYears,
    loanType,

    income,
    taxRate,
    insuranceAnnual,
    hoaMonthly,
  };
}

function listMissingInputs({ income, expenses, creditScore, downpayment, price, housingAllIn }) {
  const missing = [];
  if (!Number.isFinite(income)) missing.push("income");
  if (!Number.isFinite(expenses)) missing.push("expenses");

  if (!Number.isFinite(housingAllIn) || housingAllIn <= 0) {
    if (!Number.isFinite(price)) missing.push("price");
    if (!Number.isFinite(downpayment)) missing.push("downpayment");
    if (!Number.isFinite(creditScore)) missing.push("creditScore");
  }
  return missing;
}

// ------------------------------
// //#4 VERDICT ENGINE (DETERMINISTIC)
// ------------------------------
function computeVerdict({ income, expenses, housingAllIn }) {
  const inc = Number.isFinite(income) ? income : null;
  const exp = Number.isFinite(expenses) ? expenses : 0;
  const hou = Number.isFinite(housingAllIn) && housingAllIn > 0 ? housingAllIn : null;

  if (!inc) {
    return {
      status: "INSUFFICIENT",
      grade: "N/A",
      housingCap: null,
      ratios: { housingRatio: null, expenseRatio: null },
      residual: null,
      notes: ["Missing income; cannot compute affordability rails."],
    };
  }

  const housingCap = inc * 0.30;

  if (!hou) {
    return {
      status: "INSUFFICIENT",
      grade: "N/A",
      housingCap: Math.round(housingCap),
      ratios: { housingRatio: null, expenseRatio: exp / inc },
      residual: null,
      notes: ["Missing housing estimate; using cap + quick rails only."],
    };
  }

  const housingRatio = hou / inc;
  const residual = inc - exp - hou;

  const cushionLow = inc * 0.05;
  const cushionGood = inc * 0.12;

  let status = "GREEN";
  const notes = [];

  if (residual < 0) {
    status = "NO-GO";
    notes.push("Residual income is negative after expenses + housing.");
  } else if (hou > housingCap) {
    status = "NO-GO";
    notes.push("Housing cost exceeds the 30% housing cap.");
  } else if (residual < cushionLow) {
    status = "CAUTION";
    notes.push("Buffer is thin after expenses + housing.");
  }

  let grade = "B";
  if (status === "NO-GO") grade = "D";
  else if (status === "CAUTION") grade = "C+";
  else {
    if (housingRatio <= 0.25 && residual >= cushionGood) grade = "A";
    else if (housingRatio <= 0.28 && residual >= cushionLow) grade = "A-";
    else if (housingRatio <= 0.30 && residual >= cushionLow) grade = "B+";
    else grade = "B";
  }

  return {
    status,
    grade,
    housingCap: Math.round(housingCap),
    ratios: { housingRatio, expenseRatio: exp / inc },
    residual: Math.round(residual),
    notes,
  };
}

function pickNextAction({ verdict, missing_inputs, price, housingAllIn }) {
  if (!verdict || verdict.status === "INSUFFICIENT") {
    if (missing_inputs && missing_inputs.length) {
      return {
        type: "collect_missing_inputs",
        target: { missing: missing_inputs },
        why: "I can give quick rails now, and a tighter verdict once those inputs are provided.",
      };
    }
    return {
      type: "collect_missing_inputs",
      target: null,
      why: "Need more inputs to produce a defensible recommendation.",
    };
  }

  if (verdict.status === "NO-GO") {
    if (
      Number.isFinite(price) &&
      price > 0 &&
      Number.isFinite(housingAllIn) &&
      housingAllIn > 0 &&
      Number.isFinite(verdict.housingCap)
    ) {
      const cap = verdict.housingCap;
      const ratio = cap / housingAllIn;
      const targetPrice = roundTo(price * ratio, 1000);

      return {
        type: "lower_price",
        target: {
          current_price: Math.round(price),
          target_price: Math.max(0, Math.round(targetPrice)),
          target_housing_cap: Math.round(cap),
        },
        why: "Brings estimated all-in housing closer to the 30% cap using your current scenario.",
      };
    }

    return {
      type: "adjust_scenario",
      target: null,
      why: "Lower price, increase downpayment, reduce expenses, or improve credit to reach GREEN.",
    };
  }

  if (verdict.status === "CAUTION") {
    return {
      type: "increase_buffer",
      target: null,
      why: "Small adjustments can move you from CAUTION to GREEN (more residual buffer).",
    };
  }

  return {
    type: "lock_in_plan",
    target: null,
    why: "You’re in a stable range—next step is tightening assumptions and building the offer plan.",
  };
}

// ------------------------------
// //#5 SUPABASE PROFILE LOOKUP (DIRECT)
// ------------------------------
const SELECT_COLS_AGENT = [
  "id",
  "email",
  "full_name",
  "first_name",
  "last_name",
  "phone",
  "mode",
  "notes"
].join(",");

async function fetchProfileByEmail(email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      ok: false,
      profile: null,
      source: "supabase_env_missing",
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY",
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase
      .from("profiles")
      .select(SELECT_COLS_AGENT)
      .eq("email", email)
      .maybeSingle();

    if (error) return { ok: false, profile: null, source: "supabase:failed", error: String(error.message || error) };
    if (!data) return { ok: true, profile: null, source: "supabase:empty", error: null };

    return { ok: true, profile: data, source: "supabase:profiles", error: null };
  } catch (e) {
    return { ok: false, profile: null, source: "supabase:exception", error: String(e?.message || e) };
  }
}

// ------------------------------
// //#6 MAIN HANDLER
// ------------------------------
exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true }, origin);
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed. Use POST." }, origin);
  }

  const body = safeJsonParse(event.body);

  const email =
    normalizeEmail(
      pickFirst(
        body.email,
        body?.identity?.email,
        body?.context?.email,
        body?.context?.profile?.email
      )
    ) || "";

  const sc = buildScenario(body);

  // Pull profile from Supabase if email exists; else allow context.profile
  let profile = null;
  let profileSource = "none";
  let profileError = null;

  if (email) {
    const p = await fetchProfileByEmail(email);
    profile = p.profile;
    profileSource = p.source;
    profileError = p.error;
  }

  if (!profile && sc.contextProfile) {
    profile = sc.contextProfile;
    profileSource = "context.profile";
  }

  const name = pickName(profile);

  // Build profile_used WITHOUT assuming extra columns exist in Supabase row
  const profile_used = profile
    ? {
        email: normalizeEmail(profile.email || email) || (email || null),
        first_name: safeStr(profile.first_name) || name.first || null,
        last_name: safeStr(profile.last_name) || name.last || null,
        full_name: safeStr(profile.full_name) || name.full || null,
        phone: safeStr(profile.phone) || null,
        mode: safeStr(profile.mode) || null,
        notes: safeStr(profile.notes) || null,
      }
    : (email ? { email } : null);

  // Knowledge resolution (Basics + RealtySaSS + State)
  const resolvedStateRaw = resolveStateFromInputs({
    body,
    profile,
    contextProfile: sc.contextProfile,
  });

  const basicsLoad = loadBasics();
  const realtysassLoad = loadRealtySaSS();
  const stateLoad = loadState(resolvedStateRaw);

  const knowledge = {
    basics: basicsLoad.ok ? basicsLoad.data : null,
    realtysass: realtysassLoad.ok ? realtysassLoad.data : null,
    state: stateLoad.ok ? stateLoad.data : null,
    state_key: stateLoad.ok ? stateLoad.key : normalizeStateKey(resolvedStateRaw) || null,
  };

  const knowledge_used = {
    basics: {
      ok: basicsLoad.ok,
      file: basicsLoad.file,
      cached: basicsLoad.cached,
      error: basicsLoad.error || null,
    },
    realtysass: {
      ok: realtysassLoad.ok,
      file: realtysassLoad.file,
      cached: realtysassLoad.cached,
      error: realtysassLoad.error || null,
    },
    state: {
      ok: stateLoad.ok,
      requested: safeStr(resolvedStateRaw) || null,
      key: stateLoad.key || null,
      file: stateLoad.file || null,
      cached: stateLoad.cached || false,
      error: stateLoad.error || null,
    },
  };

  // Scenario values
  const income = num(pickFirst(sc.income, sc.contextProfile?.income, sc.contextProfile?.monthly_income));
  const price = sc.price;
  const expenses = sc.expenses;
  const downpayment = sc.downpayment;
  const creditScore = sc.creditScore;

  // Mortgage estimate (deterministic)
  let mortgage = null;
  let mortgageSource = "missing";

  if (Number.isFinite(price) && Number.isFinite(downpayment) && Number.isFinite(creditScore)) {
    const stateDefaults =
      stateLoad.ok && stateLoad.data && typeof stateLoad.data === "object"
        ? stateLoad.data.defaults || null
        : null;

    const taxRate = pickFirst(sc.taxRate, stateDefaults?.tax_rate, stateDefaults?.property_tax_rate);
    const insuranceAnnual = pickFirst(
      sc.insuranceAnnual,
      stateDefaults?.insurance_annual,
      stateDefaults?.homeowners_insurance_annual
    );
    const hoaMonthly = pickFirst(sc.hoaMonthly, stateDefaults?.hoa_monthly);

    const m = estimateAllInHousing({
      price,
      downpayment,
      creditScore,
      termYears: sc.termYears,
      taxRate: num(taxRate),
      insuranceAnnual: num(insuranceAnnual),
      hoaMonthly: num(hoaMonthly),
    });

    if (m.ok && hasPositiveMoney(m.all_in_monthly)) {
      mortgage = m;
      mortgageSource = "deterministic_estimate";
    } else {
      mortgage = { ok: false, reason: m.reason || "Mortgage estimate failed." };
      mortgageSource = "deterministic_estimate:failed";
    }
  } else {
    mortgageSource = "insufficient_inputs_for_mortgage";
  }

  const housingAllIn = mortgage?.ok ? num(mortgage.all_in_monthly) : null;

  // Quick rails
  const aprAssumed = aprTierFromScore(creditScore);
  const quick = buildQuickAffordability({
    income,
    housingCapPct: 0.30,
    buffer: 1.28,
    apr: aprAssumed,
    termYears: sc.termYears,
  });

  const verdict = computeVerdict({
    income,
    expenses,
    housingAllIn,
  });

  const missing_inputs = listMissingInputs({
    income,
    expenses,
    creditScore,
    downpayment,
    price,
    housingAllIn,
  });

  const next_action = pickNextAction({
    verdict,
    missing_inputs,
    price,
    housingAllIn,
  });

  const ts = nowTs();
  const scenario_id = makeScenarioId(email || "anon", ts);

  const inputs_used = {
    income: Number.isFinite(income) ? Math.round(income) : null,
    expenses: Number.isFinite(expenses) ? Math.round(expenses) : null,
    price: Number.isFinite(price) ? Math.round(price) : null,
    downpayment: Number.isFinite(downpayment) ? Math.round(downpayment) : null,
    creditScore: Number.isFinite(creditScore) ? creditScore : null,
    termYears: sc.termYears,
    loanType: sc.loanType,
    assumptions: {
      housing_cap_pct: 0.30,
      buffer_allin_to_pi: 1.28,
      apr_assumed: Number.isFinite(creditScore) ? aprAssumed : null,
    },
    sources: {
      email: email ? "request" : "missing",
      profile: profileSource,
      creditScore: Number.isFinite(creditScore) ? sc.creditScoreSource : "missing",
      mortgage: mortgageSource,
      quick: quick ? "deterministic_quick_rails" : "missing_income",
      knowledge_basics: basicsLoad.ok ? "file" : "missing",
      knowledge_realtysass: realtysassLoad.ok ? "file" : "missing",
      knowledge_state: stateLoad.ok ? "file" : "missing",
    },
  };

  const payload = {
    ok: true,
    scenario_id,
    ts,
    email: email || null,
    profile_used,

    intent: sc.question ? "user_question" : "affordability_check",
    question: sc.question || null,

    missing_inputs,
    inputs_used,

    knowledge,
    knowledge_used,

    quick: quick || null,

    mortgage: mortgage
      ? {
          source: mortgageSource,
          all_in_monthly: mortgage.ok ? mortgage.all_in_monthly : null,
          breakdown: mortgage.ok ? mortgage.breakdown : null,
          assumptions_used: mortgage.ok ? mortgage.assumptions_used : null,
          apr_assumed: mortgage.ok ? mortgage.apr_assumed : null,
          term_years: mortgage.ok ? mortgage.term_years : sc.termYears,
          loan_amount: mortgage.ok ? mortgage.loan_amount : null,
          error: mortgage.ok ? null : (mortgage.reason || "Mortgage estimate unavailable."),
        }
      : {
          source: mortgageSource,
          all_in_monthly: null,
          breakdown: null,
          assumptions_used: null,
          apr_assumed: Number.isFinite(creditScore) ? aprAssumed : null,
          term_years: sc.termYears,
          loan_amount: null,
          error: "Mortgage estimate unavailable (missing inputs).",
        },

    verdict,
    next_action,

    context: {
      fad_ok: !!(sc.fad && Object.keys(sc.fad).length),
      profile_ok: !!profile_used,
      state_resolved: knowledge.state_key || null,
    },
  };

  const debugEnabled =
    body?.debug === true ||
    (event.queryStringParameters &&
      (event.queryStringParameters.debug === "1" || event.queryStringParameters.debug === "true"));

  if (debugEnabled) {
    payload.debug = {
      allowOriginsCount: ALLOW_ORIGINS.length,
      profileError: profileError || null,
      fadKeys: sc.fad && sc.fad.__raw ? Object.keys(sc.fad.__raw).slice(0, 60) : [],
      creditScoreSource: sc.creditScoreSource,
      computedAprAssumed: aprAssumed,
      dataDir: DATA_DIR,
      basicsFile: BASICS_FILENAME,
      realtysassFile: REALTYSASS_FILENAME,
      stateFile: knowledge_used.state.file || null,
    };
  }

  return respond(200, payload, origin);
};
