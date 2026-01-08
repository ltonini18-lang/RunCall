// /api/google/callback.js

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

function safeJsonParse(maybeJson) {
  try { return JSON.parse(maybeJson); } catch { return null; }
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
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`
    }
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

  // Important: Google often does NOT return refresh_token except first consent
  const existing = await getExistingGoogleAccount({ expertId });
  const refreshToken =
    tokenData.refresh_token ||
    existing?.refresh_token ||
    null;

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
    console.error("Supabase upsert failed", {
      status: resp.status,
      body: text
    });
    throw new Error(`Supabase upsert failed (${resp.status})`);
  }

  return text;
}

export default async function handler(req, res) {
  try {
    const code = String(req.query.code || "");
    const stateRaw = String(req.query.state || "");
    if (!code || !stateRaw) return res.status(400).send("Missing code/state");

    // Your current connect endpoint sends JSON-encoded state.
    // We'll keep compatibility with that.
    let expertId;
    try {
      const state = JSON.parse(decodeURIComponent(stateRaw));
      expertId = String(state.expert_id || "").trim();
    } catch {
      return res.status(400).send("Invalid state");
    }

    if (!expertId) return res.status(400).send("Missing expert_id in state");

    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      console.error("Missing Google env vars", {
        hasId: !!CLIENT_ID,
        hasSecret: !!CLIENT_SECRET,
        hasRedirect: !!REDIRECT_URI
      });
      return res.status(500).send("Server not configured (Google env vars)");
    }

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

    if (!tokenRes.ok || !tokenData) {
      console.error("Token exchange failed", { status: tokenRes.status, body: tokenText });
      return res.status(500).send("Token exchange failed");
    }

    const googleEmail = tokenData?.access_token
      ? await fetchGoogleEmail(tokenData.access_token)
      : null;

    await upsertGoogleAccount({ expertId, tokenData, googleEmail });

    // ✅ NEW: redirect to dashboard instead of open-calendar
    return res.redirect(
      302,
      `/dashboard.html?expert_id=${encodeURIComponent(expertId)}&connected=1`
    );
  } catch (err) {
    console.error("Callback crashed:", err);
    return res.status(500).send("Callback crashed (check logs)");
  }
}
