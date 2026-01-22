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
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import heicConvert from 'heic-convert';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobe.path);

console.log("FFMPEG BIN:", ffmpegPath);
console.log("FFPROBE BIN:", ffprobe.path);

// Check if ffmpeg is available
try {
  ffmpeg.getAvailableFormats((err, formats) => {
    if (err) {
      console.error("FFmpeg not available:", err);
    } else {
      console.log("FFmpeg available, formats count:", Object.keys(formats).length);
    }
  });
} catch (e) {
  console.error("FFmpeg check failed:", e);
}

dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MEDIA_ROOT', 'MEDIA_BASE_URL', 'PORT'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================= CONFIG ================= */

const IMAGE_MAX_BYTES = parseInt(process.env.IMAGE_MAX_BYTES) || 20 * 1024 * 1024;      // 20MB
const VIDEO_MAX_BYTES = parseInt(process.env.VIDEO_MAX_BYTES) || 200 * 1024 * 1024;    // 200MB

const MEDIA_ROOT = process.env.MEDIA_ROOT;
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL;

/* ================= AUTH ================= */

async function verifyUser(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }

    const token = auth.replace("Bearer ", "");
    console.log("Received token:", token ? "present" : "missing");
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      console.log("Supabase auth error:", error);
      console.log("Supabase auth data:", data);
      return res.status(403).json({ error: "Invalid token" });
    }

    req.user = data.user;
    req.isAdmin = data.user.app_metadata?.role === 'admin' || data.user.user_metadata?.role === 'admin';

    // If not admin via metadata, check admin_users table
    if (!req.isAdmin) {
      try {
        const { data: adminRecord, error: adminError } = await supabase
          .from('admin_users')
          .select('id, is_active')
          .eq('id', data.user.id)
          .eq('is_active', true)
          .single();

        if (adminRecord && !adminError) {
          req.isAdmin = true;
        }
      } catch (err) {
        // Ignore errors - user might not have access to admin_users table
        console.debug('Admin check via table failed (expected for non-admins):', err.message);
      }
    }

    // For admin, allow specifying target user
    if (req.isAdmin) {
      const targetId = req.body?.target_user_id || req.query.target_user_id || req.headers['x-target-user-id'];
      const targetModelId = req.body?.target_model_id || req.query.target_model_id || req.headers['x-target-model-id'] || req.body?.model_id || req.query.model_id;

      if (targetModelId) {
        const { data: prof, error: profError } = await supabase
          .from("model_profiles")
          .select("user_id")
          .eq("id", targetModelId)
          .single();

        if (profError || !prof) {
          return res.status(400).json({ error: "Invalid target_model_id" });
        }
        req.targetUserId = prof.user_id;
      } else if (targetId) {
        req.targetUserId = targetId;
      } else {
        req.targetUserId = null; // Admin can operate without target for some endpoints
      }
    } else {
      req.targetUserId = req.user.id;
    }

    next();
  } catch (err) {
    console.error("Verify user error:", err);
    return res.status(500).json({ error: "Auth verification failed" });
  }
}

/* ================= MULTER ================= */

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const tempDir = path.join(MEDIA_ROOT, "temp");
    fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
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

async function validateVideo(filePath) {
  const type = await fileTypeFromFile(filePath);
  console.log("Video file type detected:", type);
  if (!type || !type.mime.startsWith("video/")) {
    throw new Error("Invalid video file");
  }
  const allowed = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"];
  if (!allowed.includes(type.mime)) {
    throw new Error("Unsupported video type, only MP4/MOV/AVI/WEBM accepted");
  }
  const size = fs.statSync(filePath).size;
  console.log("Video file size:", size, "limit:", VIDEO_MAX_BYTES);
  if (size > VIDEO_MAX_BYTES) {
    throw new Error("Video exceeds size limit");
  }
}

async function validateImage(filePath) {
  const type = await fileTypeFromFile(filePath);
  console.log("Image file type detected:", type);
  if (!type || !type.mime.startsWith("image/")) {
    throw new Error("Invalid image file");
  }
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  if (!allowed.includes(type.mime)) {
    throw new Error("Unsupported image type, only JPEG/PNG/WEBP/HEIC/HEIF accepted");
  }
  const size = fs.statSync(filePath).size;
  console.log("Image file size:", size, "limit:", IMAGE_MAX_BYTES);
  if (size > IMAGE_MAX_BYTES) {
    throw new Error("Image exceeds size limit");
  }
}

async function processImage({ rawPath, finalPath }) {
  let processedPath = rawPath;

  try {
    const type = await fileTypeFromFile(rawPath);
    if (type && (type.ext === 'heic' || type.ext === 'heif' || type.mime === 'image/heic' || type.mime === 'image/heif')) {
      console.log("Converting HEIC/HEIF to JPEG");
      // Convert HEIC/HEIF to JPEG
      const inputBuffer = fs.readFileSync(rawPath);
      const outputBuffer = await heicConvert({
        buffer: inputBuffer,
        format: 'JPEG',
        quality: 0.9
      });
      const tempJpegPath = rawPath.replace(/\.[^.]+$/, '_converted.jpg');
      fs.writeFileSync(tempJpegPath, outputBuffer);
      processedPath = tempJpegPath;
      // Delete original HEIC file
      fs.unlinkSync(rawPath);
      console.log('HEIC/HEIF converted to JPEG successfully');
    }
  } catch (conversionError) {
    console.error('HEIC conversion failed:', conversionError);
    throw new Error('Failed to process HEIC/HEIF image. Please convert to JPEG/PNG/WEBP on your device.');
  }

  // Process with Sharp
  await sharp(processedPath)
    .rotate()
    .resize(1920, 1080, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(finalPath);

  // Clean up temp file if created
  if (processedPath !== rawPath) {
    fs.unlinkSync(processedPath);
  }
}

function processVideoAsync({ rawPath, finalVideoPath, posterPath, mediaId, mediaRole }) {
  setImmediate(async () => {
    try {
      console.log("Starting video processing for mediaId:", mediaId, "mediaRole:", mediaRole);
      // Get video metadata to check resolution
      const metadata = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(rawPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata);
        });
      });

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const height = videoStream ? videoStream.height : 0;

      let finalVideoPathToUse = finalVideoPath;

      if (height <= 1080) {
        // No compression needed, copy original
        fs.copyFileSync(rawPath, finalVideoPath);
        console.log(`Video copied without compression (height: ${height})`);
      } else {
        // Compress the video
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
        console.log(`Video compressed from height ${height} to 1080`);
      }

      // Generate poster
      await new Promise((resolve, reject) => {
        ffmpeg(finalVideoPathToUse)
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
          media_url: finalVideoPathToUse.replace(MEDIA_ROOT, MEDIA_BASE_URL),
          poster_url: posterPath.replace(MEDIA_ROOT, MEDIA_BASE_URL),
        })
        .eq("id", mediaId);

      fs.unlinkSync(rawPath);
    } catch (err) {
      console.error("Video processing failed for mediaId:", mediaId, "error:", err.message, "stack:", err.stack);

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

const MEDIA_ROLE_LIMITS = {
  profile: 1,
  portfolio: 50,  // Updated to match database trigger
  polaroid: 6,
  intro_video: 1,
  portfolio_video: 10,
}; // Keep synced with frontend useMediaUpload maxFiles

const IMAGE_ROLES = ["profile", "portfolio", "polaroid"];
const VIDEO_ROLES = ["intro_video", "portfolio_video"];

function validateMediaRoleType(mediaRole, isVideo) {
  const expectedType = isVideo ? "video" : "image";
  const allowedRoles = isVideo ? VIDEO_ROLES : IMAGE_ROLES;

  if (!allowedRoles.includes(mediaRole)) {
    const actualType = isVideo ? "video" : "image";
    throw new Error(`Media role '${mediaRole}' requires ${expectedType} files, but received ${actualType} file`);
  }
}

app.post("/upload", upload.single("file"), verifyUser, async (req, res) => {
  let currentFilePath = null;

  try {
    console.log("Upload request - req.body:", JSON.stringify(req.body));
    console.log("req.query:", JSON.stringify(req.query));
    console.log("req.headers['x-target-model-id']:", req.headers['x-target-model-id']);
    console.log("req.isAdmin:", req.isAdmin);
    console.log("req.targetUserId:", req.targetUserId);
    console.log("req.file:", req.file ? { originalname: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype } : "no file");

    if (req.isAdmin && !req.targetUserId) {
      return res.status(400).json({ error: "target_user_id, target_model_id, or model_id required for admin users" });
    }
    const media_role = req.body.media_role;

    if (!media_role) {
      return res.status(400).json({ error: "media_role missing" });
    }

    if (!ALLOWED_MEDIA_ROLES.includes(media_role)) {
      return res.status(400).json({ error: "Invalid media_role" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "File missing" });
    }

    // Validate filename for security
    const originalName = req.file.originalname;
    if (originalName.includes('..') || originalName.includes('/') || originalName.includes('\\')) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    currentFilePath = req.file.path;

    const isVideo = req.file.mimetype.startsWith("video");
    console.log("Is video:", isVideo);

    // Validate media role matches expected type
    validateMediaRoleType(media_role, isVideo);

    if (isVideo) {
      await validateVideo(req.file.path);
    } else {
      await validateImage(req.file.path);
    }

    // Use targetUserId as profileId (assuming profile exists or will be created)
    const profileId = req.targetUserId;

    console.log("Using profile ID:", profileId);

    // Move file to correct raw directory
    const rawDir = path.join(
      MEDIA_ROOT,
      "models",
      profileId,
      "onboarding",
      media_role,
      "raw"
    );
    fs.mkdirSync(rawDir, { recursive: true });
    const rawPath = path.join(rawDir, path.basename(req.file.path));
    fs.renameSync(req.file.path, rawPath);
    currentFilePath = rawPath;
    req.file.path = rawPath;

    // Handle existing media based on role limits
    if (MEDIA_ROLE_LIMITS[media_role] === 1) {
      // For single-item roles, delete existing
      const { data: existingMedia } = await supabase
        .from("model_media")
        .select("id, media_url, poster_url")
        .eq("model_id", profileId)
        .eq("media_role", media_role)
        .single();

      if (existingMedia) {
        // Delete files
        [existingMedia.media_url, existingMedia.poster_url].forEach((url) => {
          if (!url) return;
          const p = url.replace(MEDIA_BASE_URL, MEDIA_ROOT);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        });
        // Delete row
        await supabase.from("model_media").delete().eq("id", existingMedia.id);
      }
    } else {
      // For multi-item roles, check count
      const { count, error: countError } = await supabase
        .from("model_media")
        .select("*", { count: "exact", head: true })
        .eq("model_id", profileId)
        .eq("media_role", media_role);

      console.log("Media count for role", media_role, ":", count, "error:", countError);
      if (countError) throw new Error("Failed to check media count");

      if (count >= MEDIA_ROLE_LIMITS[media_role]) {
        throw new Error(`Maximum ${MEDIA_ROLE_LIMITS[media_role]} ${media_role} uploads allowed`);
      }
    }

    const baseDir = path.join(
      MEDIA_ROOT,
      "models",
      profileId,
      "onboarding",
      media_role
    );

    fs.mkdirSync(baseDir, { recursive: true });

    const uniqueId = Date.now() + Math.floor(Math.random() * 1000);
    const finalFile = path.join(baseDir, isVideo ? `final_${uniqueId}.mp4` : `final_${uniqueId}.jpg`);
    const posterFile = path.join(baseDir, `poster_${uniqueId}.jpg`);

    const { data: insertData, error: insertError } = await supabase.from("model_media").insert({
      model_id: profileId,
      media_type: isVideo ? "video" : "image",
      media_role,
      media_url: "",
      poster_url: "",
      processing: isVideo,
    }).select().single();

    if (insertError || !insertData) {
      console.log("Insert error:", insertError);
      throw new Error(insertError?.message || "Failed to create media record");
    }

    const mediaId = insertData.id;
    console.log("Media record created, id:", mediaId);

    if (isVideo) {
      processVideoAsync({
        rawPath,
        finalVideoPath: finalFile,
        posterPath: posterFile,
        mediaId,
        mediaRole: media_role,
      });

      return res.json({
        id: mediaId,
        processing: true,
      });
    }

    await processImage({
      rawPath,
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

    // Clean up any files that may have been created
    if (currentFilePath && fs.existsSync(currentFilePath)) {
      try {
        fs.unlinkSync(currentFilePath);
        console.log("Cleaned up file:", currentFilePath);
      } catch (cleanupErr) {
        console.error("Failed to cleanup file:", currentFilePath, cleanupErr.message);
      }
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

  // For non-admin, check ownership
  if (!req.isAdmin) {
    const { data: profile, error: profileError } = await supabase
      .from("model_profiles")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (profileError || !profile || data.model_id !== profile.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
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

app.get("/", async (_, res) => {
  try {
    // Test Supabase connection
    const { data, error } = await supabase.from('model_profiles').select('count').limit(1);
    const supabaseStatus = error ? 'ERROR' : 'OK';

    // Check media directory
    const mediaDirExists = fs.existsSync(MEDIA_ROOT);
    const tempDir = path.join(MEDIA_ROOT, 'temp');
    let tempDirWritable = false;
    if (mediaDirExists) {
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'test'), 'test');
        fs.unlinkSync(path.join(tempDir, 'test'));
        tempDirWritable = true;
      } catch (e) {
        tempDirWritable = false;
      }
    }

    res.json({
      status: 'running',
      timestamp: new Date().toISOString(),
      supabase: supabaseStatus,
      media_root: {
        exists: mediaDirExists,
        writable: tempDirWritable
      },
      ffmpeg: ffmpegPath ? 'configured' : 'missing'
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message
    });
  }
});

/* ================= WHATSAPP WEBHOOK ================= */

// WhatsApp webhook verification
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('WhatsApp webhook verification failed');
    res.sendStatus(403);
  }
});

// WhatsApp webhook for receiving messages
app.post('/webhook/whatsapp', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const body = JSON.parse(req.body);

    console.log('WhatsApp webhook received:', JSON.stringify(body, null, 2));

    // Verify the request is from WhatsApp
    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(400);
    }

    // Process each entry
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages') {
          for (const message of change.value.messages || []) {
            await processWhatsAppMessage(message);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.sendStatus(500);
  }
});

// Process incoming WhatsApp messages
async function processWhatsAppMessage(message) {
  try {
    const from = message.from; // sender's phone number
    const messageId = message.id;
    const messageType = message.type;

    console.log(`Processing WhatsApp message from ${from}, type: ${messageType}`);

    if (messageType === 'text') {
      const text = message.text.body;
      console.log(`Received text: ${text}`);

      // Handle quick reply responses
      if (text.toLowerCase().includes('interested') || text.toLowerCase().includes('not interested')) {
        const response = text.toLowerCase().includes('interested') ? 'interested' : 'not_interested';

        // Find the recipient by phone number and update response
        const { data: recipient, error } = await supabase
          .from('campaign_recipients')
          .select(`
            id,
            campaign_id,
            model_id,
            campaign_recipients!inner (
              model_profiles!inner (
                phone
              )
            )
          `)
          .eq('wa_message_id', messageId)
          .single();

        if (recipient && !error) {
          await supabase
            .from('campaign_recipients')
            .update({
              response,
              responded_at: new Date().toISOString()
            })
            .eq('id', recipient.id);

          console.log(`Updated recipient ${recipient.id} response to ${response}`);
        } else {
          // Try to find by phone number if message ID doesn't match
          const { data: recipients, error: phoneError } = await supabase
            .from('campaign_recipients')
            .select(`
              id,
              campaign_id,
              model_id,
              campaign_recipients!inner (
                model_profiles!inner (
                  phone
                )
              )
            `)
            .eq('model_profiles.phone', from);

          if (recipients && recipients.length > 0 && !phoneError) {
            // Update the most recent recipient for this phone number
            const latestRecipient = recipients.sort((a, b) =>
              new Date(b.created_at) - new Date(a.created_at)
            )[0];

            await supabase
              .from('campaign_recipients')
              .update({
                response,
                responded_at: new Date().toISOString(),
                wa_message_id: messageId
              })
              .eq('id', latestRecipient.id);

            console.log(`Updated recipient ${latestRecipient.id} response to ${response} (by phone)`);
          }
        }
      }
    } else if (messageType === 'interactive') {
      // Handle button responses
      const buttonReply = message.interactive?.button_reply;
      if (buttonReply) {
        const response = buttonReply.id; // 'interested' or 'not_interested'

        // Find and update recipient
        const { data: recipient, error } = await supabase
          .from('campaign_recipients')
          .select('id')
          .eq('wa_message_id', messageId)
          .single();

        if (recipient && !error) {
          await supabase
            .from('campaign_recipients')
            .update({
              response,
              responded_at: new Date().toISOString()
            })
            .eq('id', recipient.id);

          console.log(`Updated recipient ${recipient.id} response to ${response} (button)`);
        }
      }
    }
  } catch (error) {
    console.error('Error processing WhatsApp message:', error);
  }
}

app.listen(process.env.PORT, () => {
  console.log(`Upload API running on port ${process.env.PORT}`);
});
