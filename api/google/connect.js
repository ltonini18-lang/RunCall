// /api/google/connect.js

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const expertId = String(req.query.expert_id || "").trim();

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).send("Server not configured");
  }

  const scope = encodeURIComponent(
    [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/userinfo.email"
    ].join(" ")
  );

  // 🔑 IMPORTANT :
  // - onboarding  → state = { expert_id }
  // - login       → state = { mode: "login" }
  const statePayload = expertId
    ? { expert_id: expertId }
    : { mode: "login" };

  const state = encodeURIComponent(JSON.stringify(statePayload));

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&state=${state}`;

  return res.redirect(302, authUrl);
}
