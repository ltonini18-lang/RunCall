// /api/google/callback.js

function safeJsonParse(maybeJson) {
  try { return JSON.parse(maybeJson); } catch { return null; }
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

function parseState(stateRaw) {
  // stateRaw is already URL-decoded by Node sometimes, but not always.
  // We'll try both.
  const attempts = [stateRaw, decodeURIComponent(stateRaw)];
  for (const a of attempts) {
    const obj = safeJsonParse(a);
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}

/** Find existing expert id by email, else create draft expert and return its id */
async function findOrCreateExpertIdByEmail(googleEmail) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing Supabase env vars");

  // 1) find
  const findUrl =
    `${SUPABASE_URL}/rest/v1/experts` +
    `?email=eq.${encodeURIComponent(googleEmail)}` +
    `&select=id&limit=1`;

  const fr = await fetch(findUrl, {
    method: "GET",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
  });

  const ft = await fr.text();
  const fd = safeJsonParse(ft);
  if (Array.isArray(fd) && fd.length && fd[0]?.id) return fd[0].id;

  // 2) create draft
  const payload = [{
    email: googleEmail,
    name: googleEmail.split("@")[0],
    presentation: "",
    status: "draft",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }];

  const cr = await fetch(`${SUPABASE_URL}/rest/v1/experts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });

  const ct = await cr.text();
  const cd = safeJsonParse(ct);
  if (Array.isArray(cd) && cd.length && cd[0]?.id) return cd[0].id;

  throw new Error("Failed to create expert");
}

// --- keep your existing getExistingGoogleAccount / upsertGoogleAccount here ---
// (je ne les recolle pas pour éviter les erreurs de merge)
// IMPORTANT: upsertGoogleAccount({ expertId, tokenData, googleEmail }) must still exist.

export default async function handler(req, res) {
  try {
    const code = String(req.query.code || "").trim();
    const stateRaw = String(req.query.state || "").trim();
    if (!code || !stateRaw) return res.status(400).send("Missing code/state");

    const state = parseState(stateRaw);
    if (!state) return res.status(400).send("Invalid state");

    const isLogin = state.flow === "login" || state.mode === "login";
    let expertId = state.expert_id ? String(state.expert_id).trim() : null;

    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
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

    // ✅ LOGIN flow: resolve expertId by googleEmail
    if (isLogin) {
      if (!googleEmail) return res.status(400).send("Unable to retrieve Google email");
      expertId = await findOrCreateExpertIdByEmail(googleEmail);
    }

    // ✅ Onboarding flow must have expert_id
    if (!expertId) {
      // This is where your old code said "Missing expert_id in state"
      // Now we keep it but it's only for onboarding
      return res.status(400).send("Missing expert_id in state (onboarding)");
    }

    // Save tokens
    await upsertGoogleAccount({ expertId, tokenData, googleEmail });

    // Redirect to dashboard
    return res.redirect(
      302,
      `/dashboard.html?expert_id=${encodeURIComponent(expertId)}&connected=1`
    );
  } catch (err) {
    console.error("Callback crashed:", err);
    return res.status(500).send("Callback crashed (check logs)");
  }
}
