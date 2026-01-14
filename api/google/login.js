// /api/google/login.js
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  if (!CLIENT_ID) return res.status(500).send("Server not configured");

  // ✅ Build redirect URI from current host (preview vs prod)
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const REDIRECT_URI = `${proto}://${host}/api/google/callback`;

  const scope = encodeURIComponent(
    [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events"
    ].join(" ")
  );

  // ✅ Return to the environment that initiated login
  const baseUrl = `${proto}://${host}`;
  const next = `${baseUrl}/dashboard.html`;

  const state = encodeURIComponent(JSON.stringify({ flow: "login", next }));

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&include_granted_scopes=true` +
    `&prompt=select_account` +
    `&state=${state}`;

  return res.redirect(302, authUrl);
}
