import formidable from "formidable";
import fs from "fs";
import { supabaseAdmin } from "../../_lib/supabase";

export const config = {
  api: { bodyParser: false }, // obligatoire pour multipart
};

function getAuth(req) {
  const expert_id = String(req.query.expert_id || "").trim();
  const headerToken = req.headers["x-dashboard-token"];
  const queryToken = req.query.dashboard_token;
  const dashboard_token = String(headerToken || queryToken || "").trim();

  return { expert_id, dashboard_token };
}

function extFromMime(mime) {
  if (!mime) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "jpg";
}

async function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 8 * 1024 * 1024, // 8MB
  });

  return await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { expert_id, dashboard_token } = getAuth(req);
    if (!expert_id) return res.status(400).json({ error: "Missing expert_id" });
    if (!dashboard_token) return res.status(401).json({ error: "Missing dashboard_token" });

    const sb = supabaseAdmin();

    // ✅ auth: expert_id + dashboard_token must match
    const { data: expert, error: e1 } = await sb
      .from("experts")
      .select("id,dashboard_token,photo_path")
      .eq("id", expert_id)
      .maybeSingle();

    if (e1) return res.status(500).json({ error: "DB error", details: e1.message });
    if (!expert) return res.status(404).json({ error: "Expert not found" });
    if (expert.dashboard_token !== dashboard_token) return res.status(403).json({ error: "Invalid dashboard_token" });

    const { files } = await parseForm(req);
    const file = files.file;
    if (!file) return res.status(400).json({ error: "Missing file field 'file'" });

    const filepath = file.filepath || file.path; // depending formidable version
    const mime = file.mimetype || file.type;
    const ext = extFromMime(mime);

    // ✅ stable path (overwrite) = clean long-terme
    const storagePath = `experts/${expert_id}/avatar.${ext}`;

    const buffer = await fs.promises.readFile(filepath);

    // upload (upsert = overwrite)
    const { error: upErr } = await sb.storage
      .from("avatars")
      .upload(storagePath, buffer, {
        contentType: mime || "image/jpeg",
        upsert: true,
      });

    if (upErr) return res.status(500).json({ error: "Upload error", details: upErr.message });

    // update DB
    const { error: upDbErr } = await sb
      .from("experts")
      .update({
        photo_path: storagePath,
        photo_updated_at: new Date().toISOString(),
        // on garde photo_url pour legacy, mais on ne l’utilise plus
      })
      .eq("id", expert_id);

    if (upDbErr) return res.status(500).json({ error: "DB update error", details: upDbErr.message });

    return res.status(200).json({ ok: true, photo_path: storagePath });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
