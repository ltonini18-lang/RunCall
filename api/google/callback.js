// /api/google/callback.js

function safeJsonParse(maybeJson) {
  try { return JSON.parse(maybeJson); } catch { return null; }
}

// Robust decode: Google state can be single-encoded or double-encoded depending on how it was generated.
function robustDecodeURIComponent(input) {
  let s = String(input || "");
  for (let i = 0; i < 3; i++) {
    try {
      const dec = decodeURIComponent(s);
      if (dec === s) break;
      s = dec;
    } catch {
      break;
    }
  }
  return s;
}

function parseOAuthState(stateRaw) {
  const decoded = robustDecodeURIComponent(stateRaw);
  const obj = safeJsonParse(decoded);

  if (!obj || typeof obj !== "object") {
    return { expertId: null, isLogin: false, next: null, raw: decoded };
  }

  const expertId = obj.expert_id ? String(obj.expert_id).trim() : null;

  // Accept several variants to be future-proof
  const isLogin =
    !expertId &&
    (obj.flow === "login" || obj.mode === "login" || obj.type === "login");

  const next = typeof obj.next === "string" ? obj.next : null;

  return { expertId, isLogin, next, raw: decoded };
}

async function fetchGoogleEmail(accessToken) {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.email || null;
  } catch {
    return null;
  }
}

async function findOrCreateExpertIdByEmail(googleEmail) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing Supabase env vars");

  // 1) Find
  const findUrl =
    `${SUPABASE_URL}/rest/v1/experts` +
    `?email=eq.${encodeURIComponent(googleEmail)}` +
    `&select=id&limit=1`;

  const findResp = await fetch(findUrl, {
    method: "GET",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
  });

  const findText = await findResp.text();
  if (!findResp.ok) {
    console.error("Supabase find expert failed", { status: findResp.status, body: findText });
    throw new Error(`Supabase find expert failed (${findResp.status})`);
  }

  const found = safeJsonParse(findText);
  if (Array.isArray(found) && found.length && found[0]?.id) {
    return String(found[0].id);
  }

  // 2) Create draft
  const payload = {
    email: googleEmail,
    name: googleEmail.split("@")[0],
    presentation: "",
    status: "draft",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const createResp = await fetch(`${SUPABASE_URL}/rest/v1/experts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "return=representation"
    },
    body: JSON.stringify([payload])
  });

  const createText = await createResp.text();
  if (!createResp.ok) {
    console.error("Supabase create expert failed", { status: createResp.status, body: createText });
    throw new Error(`Supabase create expert failed (${createResp.status})`);
  }

  const created = safeJsonParse(createText);
  if (Array.isArray(created) && created.length && created[0]?.id) {
    return String(created[0].id);
  }

  throw new Error("Expert creation returned empty result");
}

async function getExistingGoogleAccount({ expertId }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing Supabase env vars");

  const url =
    `${SUPABASE_URL}/rest/v1/expert_google_accounts` +
    `?expert_id=eq.${encodeURIComponent(expertId)}` +
    `&select=refresh_token,calendar_id,google_email`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error("Supabase read failed", { status: resp.status, body: text });
    throw new Error(`Supabase read failed (${resp.status})`);
  }

  const arr = safeJsonParse(text);
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

async function upsertGoogleAccount({ expertId, tokenData, googleEmail }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing Supabase env vars");

  const existing = await getExistingGoogleAccount({ expertId });
  const refreshToken = tokenData.refresh_token || existing?.refresh_token || null;

  const payload = {
    expert_id: expertId,
    provider: "google",
    google_email: googleEmail || existing?.google_email || null,
    calendar_id: "primary",
    access_token: tokenData.access_token || null,
    refresh_token: refreshToken,
    token_type: tokenData.token_type || null,
    scope: tokenData.scope || null,
    expiry_date: tokenData.expires_in ? (Date.now() + tokenData.expires_in * 1000) : null,
    updated_at: new Date().toISOString()
  };

  const url = `${SUPABASE_URL}/rest/v1/expert_google_accounts?on_conflict=expert_id`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify([payload])
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error("Supabase upsert failed", { status: resp.status, body: text });
    throw new Error(`Supabase upsert failed (${resp.status})`);
  }

  return text;
}

/** ✅ NEW: Create a RunCall session token in `public.sessions` */
async function createRunCallSessionToken(expertId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing Supabase env vars");

  // Strong random token (UUID-like)
  const token = (globalThis.crypto?.randomUUID?.())
    || `tok_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;

  const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "return=representation"
    },
    body: JSON.stringify([{ token, expert_id: expertId, expires_at }])
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error("Supabase create session failed", { status: resp.status, body: text });
    throw new Error(`Supabase create session failed (${resp.status})`);
  }

  return { token, expires_at };
}

// Allowlist for redirects (avoid open redirect)
function sanitizeNext(next) {
  if (!next) return null;
  try {
    const u = new URL(next);
    const host = u.hostname.toLowerCase();

    const ok =
      host === "www.run-call.com" ||
      host === "preview.run-call.com" ||
      host.endsWith(".vercel.app");

    if (!ok) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const code = String(req.query.code || "");
    const stateRaw = String(req.query.state || "");
    if (!code || !stateRaw) return res.status(400).send("Missing code/state");

    const { expertId: expertIdFromState, isLogin, next } = parseOAuthState(stateRaw);
    let expertId = expertIdFromState; // may be null in login flow

    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).send("Server not configured (Google env vars)");
    }

    // Must match EXACT redirect_uri used in /login or /connect
    // - If /login forces www.run-call.com callback => this will correctly be www.run-call.com here.
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    const REDIRECT_URI = `${proto}://${host}/api/google/callback`;

    // Exchange code -> tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    const tokenText = await tokenRes.text();
    const tokenData = safeJsonParse(tokenText);

    if (!tokenRes.ok || !tokenData?.access_token) {
      console.error("Token exchange failed", { status: tokenRes.status, body: tokenText });
      return res.status(500).send("Token exchange failed");
    }

    const googleEmail = await fetchGoogleEmail(tokenData.access_token);
    if (!googleEmail) {
      return res.status(400).send("Unable to retrieve Google email");
    }

    // LOGIN flow: resolve expert_id by Google email
    if (!expertId && isLogin) {
      expertId = await findOrCreateExpertIdByEmail(googleEmail);
    }

    // ONBOARDING flow must have expertId
    if (!expertId) {
      console.error("State parsed but no expertId resolved", {
        isLogin,
        stateRaw,
        parsed: parseOAuthState(stateRaw)
      });
      return res.status(400).send("Missing expert_id in state payload");
    }

    await upsertGoogleAccount({ expertId, tokenData, googleEmail });

    /** ✅ NEW: create RunCall token session */
    const { token } = await createRunCallSessionToken(expertId);

    const safeNext = sanitizeNext(next);
    const dest = safeNext || `/dashboard.html`;
    const join = dest.includes("?") ? "&" : "?";

    // ✅ CHANGED: redirect with token (not expert_id)
    return res.redirect(
      302,
      `${dest}${join}token=${encodeURIComponent(token)}&connected=1`
    );
  } catch (err) {
    console.error("Callback crashed:", err);
    return res.status(500).send("Callback crashed (check logs)");
  }
}
