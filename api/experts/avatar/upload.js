import formidable from "formidable";
import fs from "fs";
import { supabaseAdmin } from "../../_lib/supabase";
import { resolveSession } from "../../_lib/session";

export const config = { api: { bodyParser: false } };

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = new Set([
    "https://www.run-call.com",
    "https://run-call.com",
    "https://preview.run-call.com"
  ]);
  if (allowed.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-runcall-token");
}

function extFromMime(mime) {
  if (!mime) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

async function parseForm(req) {
  const form = formidable({ multiples: false, maxFileSize: 8 * 1024 * 1024 });
  return await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    );
  });
}

export default async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const r = await resolveSession(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error, details: r.details });

    const sb = supabaseAdmin();

    const { files } = await parseForm(req);

    const fileRaw = files?.file;
    const file = Array.isArray(fileRaw) ? fileRaw[0] : fileRaw;
    if (!file) return res.status(400).json({ error: "Missing file field 'file'" });

    const filepath = file.filepath || file.path;
    const mime = file.mimetype || file.type;
    const ext = extFromMime(mime);

    if (!filepath) return res.status(400).json({ error: "Missing uploaded file path" });

    const buffer = await fs.promises.readFile(filepath);

    // upsert stable path
    const path = `experts/${r.expert_id}/avatar.${ext}`;

    const { error: upErr } = await sb.storage.from("avatars").upload(path, buffer, {
      contentType: mime || "image/jpeg",
      upsert: true
    });
    if (upErr) return res.status(500).json({ error: "Upload error", details: upErr.message });

    const { error: dbErr } = await sb
      .from("experts")
      .update({ photo_path: path, photo_updated_at: new Date().toISOString() })
      .eq("id", r.expert_id);

    if (dbErr) return res.status(500).json({ error: "DB update error", details: dbErr.message });

    const { data: signed, error: signErr } = await sb.storage
      .from("avatars")
      .createSignedUrl(path, 60 * 10);

    if (signErr) return res.status(200).json({ ok: true, photo_url: null });

    return res.status(200).json({ ok: true, photo_url: signed?.signedUrl || null });
  } catch (e) {
    console.error("avatar upload error:", e);
    return res.status(500).json({ error: "Server error", details: e?.message || String(e) });
  }
}
