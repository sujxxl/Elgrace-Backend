import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
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

/* ================= CONFIG ================= */

const IMAGE_MAX_BYTES = 6 * 1024 * 1024;      // 6MB
const VIDEO_MAX_BYTES = 110 * 1024 * 1024;    // 110MB

const MEDIA_ROOT = process.env.MEDIA_ROOT;
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL;

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

    const dir = path.join(
      MEDIA_ROOT,
      "models",
      req.user.id,
      "onboarding",
      media_role,
      "raw"
    );

    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },

  filename(_, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: VIDEO_MAX_BYTES },
});

/* ================= HELPERS ================= */

async function validateImage(filePath) {
  const type = await fileTypeFromFile(filePath);
  if (!type || !type.mime.startsWith("image/")) {
    throw new Error("Invalid image file");
  }
  if (fs.statSync(filePath).size > IMAGE_MAX_BYTES) {
    throw new Error("Image exceeds size limit");
  }
}

async function processImage({ rawPath, finalPath }) {
  await sharp(rawPath)
    .rotate()
    .resize(1920, 1080, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(finalPath);

  fs.unlinkSync(rawPath);
}

function processVideoAsync({ rawPath, finalVideoPath, posterPath, mediaId }) {
  setImmediate(async () => {
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(rawPath)
          .outputOptions([
            "-movflags faststart",
            "-pix_fmt yuv420p",
            "-profile:v main",
            "-preset veryfast",
            "-crf 23",
          ])
          .size("?x1080")
          .output(finalVideoPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      await new Promise((resolve, reject) => {
        ffmpeg(finalVideoPath)
          .screenshots({
            count: 1,
            timemarks: ["1"],
            filename: path.basename(posterPath),
            folder: path.dirname(posterPath),
            size: "640x?",
          })
          .on("end", resolve)
          .on("error", reject);
      });

      await supabase
        .from("model_media")
        .update({
          processing: false,
          media_url: finalVideoPath.replace(MEDIA_ROOT, MEDIA_BASE_URL),
          poster_url: posterPath.replace(MEDIA_ROOT, MEDIA_BASE_URL),
        })
        .eq("id", mediaId);

      fs.unlinkSync(rawPath);
    } catch (err) {
      console.error("Video processing failed:", err.message);

      await supabase
        .from("model_media")
        .update({
          processing: false,
          processing_error: err.message,
        })
        .eq("id", mediaId);
    }
  });
}

/* ================= UPLOAD ================= */

const ALLOWED_MEDIA_ROLES = [
  "profile",
  "portfolio",
  "polaroid",
  "intro_video",
  "portfolio_video",
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

    const isVideo = req.file.mimetype.startsWith("video");

    if (!isVideo) {
      await validateImage(req.file.path);
    }

    const { data: profile, error: profileError } = await supabase
      .from("model_profiles")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (profileError || !profile) throw new Error("Model profile not found");

    const baseDir = path.join(
      MEDIA_ROOT,
      "models",
      profile.id,
      "onboarding",
      media_role
    );

    fs.mkdirSync(baseDir, { recursive: true });

    const finalFile = path.join(baseDir, isVideo ? "final.mp4" : "final.jpg");
    const posterFile = path.join(baseDir, "poster.jpg");

    const { data: insertData, error: insertError } = await supabase.from("model_media").insert({
      model_id: profile.id,
      media_type: isVideo ? "video" : "image",
      media_role,
      media_url: "",
      poster_url: "",
      processing: isVideo,
    }).select().single();

    if (insertError || !insertData) throw new Error(insertError?.message || "Failed to create media record");

    const mediaId = insertData.id;

    if (isVideo) {
      processVideoAsync({
        rawPath: req.file.path,
        finalVideoPath: finalFile,
        posterPath: posterFile,
        mediaId,
      });

      return res.json({
        id: mediaId,
        processing: true,
      });
    }

    await processImage({
      rawPath: req.file.path,
      finalPath: finalFile,
    });

    await supabase
      .from("model_media")
      .update({
        media_url: finalFile.replace(MEDIA_ROOT, MEDIA_BASE_URL),
        processing: false,
      })
      .eq("id", mediaId);

    res.json({
      id: mediaId,
      processing: false,
      url: finalFile.replace(MEDIA_ROOT, MEDIA_BASE_URL),
    });
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

  if (error) return res.status(500).json({ error: "Fetch failed" });

  res.json(data || []);
});

/* ================= DELETE MEDIA ================= */

app.delete("/media", verifyUser, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "id required" });

  const { data, error } = await supabase
    .from("model_media")
    .select("media_url, poster_url, model_id")
    .eq("id", id)
    .single();

  if (error || !data) return res.status(404).json({ error: "Media not found" });

  const { data: profile, error: profileError } = await supabase
    .from("model_profiles")
    .select("id")
    .eq("user_id", req.user.id)
    .single();

  if (profileError || !profile || data.model_id !== profile.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  [data.media_url, data.poster_url].forEach((url) => {
    if (!url) return;
    const p = url.replace(MEDIA_BASE_URL, MEDIA_ROOT);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  await supabase.from("model_media").delete().eq("id", id);

  res.json({ success: true });
});

/* ================= HEALTH ================= */

app.get("/", (_, res) => res.send("Upload API running"));

app.listen(process.env.PORT, () => {
  console.log(`Upload API running on port ${process.env.PORT}`);
});
