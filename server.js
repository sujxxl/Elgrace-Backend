import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================= AUTH ================= */

async function verifyUser(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = auth.replace("Bearer ", "");
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(403).json({ error: "Invalid token" });
  }

  req.user = data.user;
  next();
}

/* ================= MULTER ================= */

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const media_role =
      req.body.media_role ||
      req.query.media_role ||
      req.headers["x-media-role"];

    if (!media_role) return cb(new Error("media_role missing"));

    const dir = `${process.env.MEDIA_ROOT}/models/${req.user.id}/onboarding/${media_role}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },

  filename(req, file, cb) {
    const media_role =
      req.body.media_role ||
      req.query.media_role ||
      req.headers["x-media-role"];

    if (media_role === "profile") return cb(null, "profile.jpg");
    if (media_role === "intro_video") return cb(null, "intro_video.mp4");

    const ext = file.originalname.split(".").pop();
    cb(null, `${Date.now()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

/* ================= UPLOAD ================= */

app.post("/upload", verifyUser, upload.single("file"), async (req, res) => {
  try {
    const media_role =
      req.body.media_role ||
      req.query.media_role ||
      req.headers["x-media-role"];

    if (!["profile", "portfolio", "intro_video"].includes(media_role)) {
      return res.status(400).json({ error: "Invalid media_role" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "File missing" });
    }

    const media_type = req.file.mimetype.startsWith("video")
      ? "video"
      : "image";

    const media_url = `${process.env.MEDIA_BASE_URL}/models/${req.user.id}/onboarding/${media_role}/${req.file.filename}`;

    /* ===== FORCE SINGLETON LOGIC ===== */
    if (media_role === "profile" || media_role === "intro_video") {
      // Delete old DB rows (if any)
      await supabase
        .from("model_media")
        .delete()
        .eq("model_id", req.user.id)
        .eq("media_role", media_role);
    }

    // Always insert fresh row
    const { error } = await supabase.from("model_media").insert({
      model_id: req.user.id,
      media_type,
      media_role,
      media_url,
      sort_order: 0,
    });

    if (error) {
      console.error("DB error:", error);
      return res.status(500).json({ error: "Database error" });
    }

    res.json({ url: media_url });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ================= GET MEDIA ================= */

app.get("/media", async (req, res) => {
  const { model_id } = req.query;
  if (!model_id) return res.status(400).json({ error: "model_id required" });

  const { data, error } = await supabase
    .from("model_media")
    .select("*")
    .eq("model_id", model_id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Fetch error:", error);
    return res.status(500).json({ error: "Fetch failed" });
  }

  res.json(data || []);
});

/* ================= DELETE MEDIA ================= */

app.delete("/media", verifyUser, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "id required" });

  const { data, error } = await supabase
    .from("model_media")
    .select("media_url, model_id")
    .eq("id", id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Media not found" });
  }

  if (data.model_id !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const filepath = data.media_url.replace(
    process.env.MEDIA_BASE_URL,
    "/var/www/media"
  );

  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }

  await supabase.from("model_media").delete().eq("id", id);

  res.json({ success: true });
});

/* ================= HEALTH ================= */

app.get("/", (_, res) => res.send("Upload API running"));

app.listen(process.env.PORT, () => {
  console.log(`Upload API running on port ${process.env.PORT}`);
});
