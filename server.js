import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileTypeFromFile } from "file-type";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffprobe from "ffprobe-static";

ffmpeg.setFfprobePath(ffprobe.path);
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================= LIMITS ================= */

const IMAGE_MAX_BYTES = 6 * 1024 * 1024;      // 6MB
const VIDEO_MAX_BYTES = 110 * 1024 * 1024;    // 110MB
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MAX_VIDEO_DURATION = 90; // seconds

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

/* ================= MULTER STORAGE ================= */

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
  limits: {
    fileSize: VIDEO_MAX_BYTES, // global hard cap
  },
});

/* ================= VALIDATION HELPERS ================= */

async function validateImage(filePath) {
  const type = await fileTypeFromFile(filePath);
  if (!type || !["image/jpeg", "image/png", "image/webp"].includes(type.mime)) {
    throw new Error("Invalid image type");
  }

  const meta = await sharp(filePath).metadata();

  if (meta.width > MAX_WIDTH || meta.height > MAX_HEIGHT) {
    throw new Error("Image resolution exceeds 1920x1080");
  }

  if (meta.size > IMAGE_MAX_BYTES) {
    throw new Error("Image exceeds 5MB limit");
  }
}

async function validateVideo(filePath) {
  const type = await fileTypeFromFile(filePath);
  if (
    !type ||
    !["video/mp4", "video/webm", "video/quicktime"].includes(type.mime)
  ) {
    throw new Error("Invalid video type");
  }

  const probe = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  const stream = probe.streams.find(s => s.width && s.height);
  if (!stream) throw new Error("Invalid video stream");

  if (stream.width > MAX_WIDTH || stream.height > MAX_HEIGHT) {
    throw new Error("Video resolution exceeds 1920x1080");
  }

  if (probe.format.duration > MAX_VIDEO_DURATION) {
    throw new Error("Video duration too long");
  }
}

/* ================= UPLOAD ================= */

const ALLOWED_MEDIA_ROLES = [
  "profile",
  "portfolio",
  "portfolio_video",
  "intro_video",
];

app.post("/upload", verifyUser, upload.single("file"), async (req, res) => {
  try {
    const media_role =
      req.body.media_role ||
      req.query.media_role ||
      req.headers["x-media-role"];

    if (!ALLOWED_MEDIA_ROLES.includes(media_role)) {
      return res.status(400).json({ error: "Invalid media_role" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "File missing" });
    }

    if (req.file.mimetype.startsWith("image")) {
      await validateImage(req.file.path);
    }

    if (req.file.mimetype.startsWith("video")) {
      await validateVideo(req.file.path);
    }

    const { data: profile, error: profileError } = await supabase
      .from("model_profiles")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (profileError || !profile) {
      throw new Error("Model profile not found");
    }

    const media_type = req.file.mimetype.startsWith("video")
      ? "video"
      : "image";

    const media_url = `${process.env.MEDIA_BASE_URL}/models/${profile.id}/onboarding/${media_role}/${req.file.filename}`;

    if (media_role === "profile" || media_role === "intro_video") {
      await supabase
        .from("model_media")
        .delete()
        .eq("model_id", profile.id)
        .eq("media_role", media_role);
    }

    await supabase.from("model_media").insert({
      model_id: profile.id,
      media_type,
      media_role,
      media_url,
      sort_order: 0,
    });

    res.json({ url: media_url });
  } catch (err) {
    console.error("Upload error:", err.message);

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(400).json({ error: err.message });
  }
});

/* ================= GET MEDIA ================= */

app.get("/media", async (req, res) => {
  const { model_id } = req.query;
  if (!model_id) {
    return res.status(400).json({ error: "model_id required" });
  }

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

  const { data: profile } = await supabase
    .from("model_profiles")
    .select("id")
    .eq("user_id", req.user.id)
    .single();

  if (!profile || data.model_id !== profile.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const filepath = data.media_url.replace(
    process.env.MEDIA_BASE_URL,
    process.env.MEDIA_ROOT
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
