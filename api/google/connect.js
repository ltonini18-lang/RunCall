// /api/google/connect.js

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const expertId = String(req.query.expert_id || "").trim();
  if (!expertId) return res.status(400).send("Missing expert_id");

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).send("Server not configured");
  }

  const scope = encodeURIComponent(
    [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly"
    ].join(" ")
  );

  const state = encodeURIComponent(JSON.stringify({ expert_id: expertId }));

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${state}`;

  return res.redirect(302, authUrl);
}
