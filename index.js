// =====================================================
// FILE: index.js (FinanceTubeAI Render API v3.4.0-PRODUCTION)
// PURPOSE: Merge image + audio into vertical YouTube Shorts-ready MP4
// COMPATIBLE WITH: Apps Script v3.9.1+
// =====================================================

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";

const execPromise = promisify(exec);
const app = express();

// ─────────────── FFmpeg Check ───────────────
try {
  const version = execSync("ffmpeg -version", { encoding: "utf-8" });
  console.log("✅ FFmpeg available:", version.split("\n")[0]);
} catch (e) {
  console.error("❌ FFmpeg not found - Install with: apt-get install -y ffmpeg");
  process.exit(1);
}

// ─────────────── Middleware ───────────────
app.use(express.json({ limit: "100mb" }));
app.use(cors());

// ─────────────── Directories ───────────────
const TMP_DIR = path.join(process.cwd(), "temp");
const VIDEO_DIR = path.join(process.cwd(), "public", "videos");
[TMP_DIR, VIDEO_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

// ─────────────── Job Tracking ───────────────
const videoJobs = new Map();
const MAX_JOB_AGE = 3600000;
const MAX_ACTIVE_JOBS = 100;

// ─────────────── Cleanup ───────────────
function cleanupOldJobs() {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, job] of videoJobs.entries()) {
    if (now - job.createdAt > MAX_JOB_AGE) {
      videoJobs.delete(id);
      const videoPath = path.join(VIDEO_DIR, `${id}.mp4`);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          cleaned++;
        } catch (e) {
          console.error(`Cleanup error ${id}:`, e.message);
        }
      }
    }
  }

  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old jobs`);

  if (videoJobs.size > MAX_ACTIVE_JOBS) {
    const excess = videoJobs.size - MAX_ACTIVE_JOBS;
    const oldest = Array.from(videoJobs.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, excess);
    oldest.forEach(([id]) => videoJobs.delete(id));
    console.log(`⚠️ Purged ${excess} oldest jobs`);
  }
}
setInterval(cleanupOldJobs, 900000);

// ─────────────── Text Utils ───────────────
function sanitizeText(text) {
  if (!text) return "";
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'")
    .replace(/"/g, '\\"')
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .trim();
}

function wrapText(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length <= maxChars) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.join("\\n");
}

// ─────────────── Routes ───────────────
app.get("/", (req, res) =>
  res.json({ 
    status: "online", 
    version: "3.4.0-PRODUCTION",
    uptime: Math.floor(process.uptime())
  })
);

app.get("/health", (req, res) => {
  try {
    const mem = process.memoryUsage();
    res.json({
      status: "healthy",
      version: "3.4.0-PRODUCTION",
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + "MB",
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + "MB"
      },
      jobs: {
        active: videoJobs.size,
        processing: [...videoJobs.values()].filter(j => j.status === "processing").length,
        completed: [...videoJobs.values()].filter(j => j.status === "complete").length,
        errors: [...videoJobs.values()].filter(j => j.status === "error").length
      }
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

app.post("/api/merge", async (req, res) => {
  try {
    const { image, audio, caption } = req.body;
    
    if (!image || !audio)
      return res.status(400).json({
        error: "Missing base64 image or audio",
        received: { hasImage: !!image, hasAudio: !!audio }
      });

    const id = uuidv4();
    const imgPath = path.join(TMP_DIR, `${id}.jpg`);
    const audPath = path.join(TMP_DIR, `${id}.mp3`);
    const outPath = path.join(VIDEO_DIR, `${id}.mp4`);

    let imgBuffer, audBuffer;
    try {
      imgBuffer = Buffer.from(image, "base64");
      audBuffer = Buffer.from(audio, "base64");
    } catch (e) {
      return res.status(400).json({ error: "Invalid base64", details: e.message });
    }

    const imgKB = Math.round(imgBuffer.length / 1024);
    const audKB = Math.round(audBuffer.length / 1024);
    console.log(`📦 Job ${id}: img=${imgKB}KB aud=${audKB}KB cap="${caption?.substring(0, 40)}"`);

    if (imgBuffer.length < 1000 || audBuffer.length < 1000)
      return res.status(400).json({ error: "File too small" });

    fs.writeFileSync(imgPath, imgBuffer);
    fs.writeFileSync(audPath, audBuffer);

    videoJobs.set(id, {
      status: "processing",
      createdAt: Date.now(),
      imageSizeKB: imgKB,
      audioSizeKB: audKB,
      caption: caption || null
    });

    const base = `${req.protocol}://${req.get("host")}`;
    res.json({
      status: "processing",
      video_id: id,
      check_url: `${base}/videos/${id}.mp4`,
      status_url: `${base}/api/status/${id}`
    });

    processVideo(id, imgPath, audPath, outPath, caption).catch(err =>
      console.error(`❌ Process ${id}:`, err.message)
    );
  } catch (error) {
    console.error("❌ Merge error:", error);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

app.get("/api/status/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ id: req.params.id, ...job });
});

// ─────────────── Video Processing ───────────────
async function processVideo(id, imgPath, audPath, outPath, caption) {
  const started = Date.now();
  try {
    console.log(`🎬 Processing ${id}`);

    const rawText = caption || "FinanceTubeAI";
    const wrappedText = wrapText(rawText, 35);
    const safeText = sanitizeText(wrappedText);

    const vfFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[a];[a]split=2[b][fg];[b]scale=1080:1920,boxblur=30:30[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p,drawbox=y=h-280:color=black@0.6:width=iw:height=160:t=max,drawtext=text='${safeText}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h-220:shadowcolor=black@0.8:shadowx=3:shadowy=3:line_spacing=10`;

    const cmd = `ffmpeg -y -hide_banner -loglevel warning -loop 1 -framerate 1 -i "${imgPath}" -i "${audPath}" -vf "${vfFilter}" -c:v libx264 -pix_fmt yuv420p -preset veryfast -tune stillimage -crf 23 -c:a aac -b:a 160k -ar 44100 -shortest -movflags +faststart -max_muxing_queue_size 1024 -avoid_negative_ts make_zero "${outPath}"`;

    console.log(`▶️ FFmpeg: ${id}`);
    const { stderr } = await execPromise(cmd, { timeout: 420000 });
    if (stderr) console.log(`⚠️ FFmpeg stderr: ${stderr.slice(0, 300)}`);

    if (!fs.existsSync(outPath)) throw new Error("Output not created");
    
    const stats = fs.statSync(outPath);
    const sizeKB = Math.round(stats.size / 1024);
    
    if (stats.size < 200000) throw new Error(`File too small: ${sizeKB}KB`);

    videoJobs.set(id, {
      status: "complete",
      videoId: id,
      size: stats.size,
      sizeKB,
      url: `/videos/${id}.mp4`,
      processingTime: Math.round((Date.now() - started) / 1000),
      caption: rawText,
      createdAt: videoJobs.get(id).createdAt
    });
    
    console.log(`✅ ${id} done: ${sizeKB}KB in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    console.error(`❌ Failed ${id}:`, e.message);
    videoJobs.set(id, {
      status: "error",
      error: e.message,
      createdAt: videoJobs.get(id)?.createdAt || Date.now()
    });
    if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch {}
  } finally {
    [imgPath, audPath].forEach(f => {
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
    });
  }
}

// ─────────────── Serve Videos ───────────────
app.use("/videos", express.static(VIDEO_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) {
      try {
        const stats = fs.statSync(filePath);
        res.set({
          "Content-Type": "video/mp4",
          "Content-Length": stats.size,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        });
      } catch (e) {
        console.error("Header error:", e.message);
      }
    }
  }
}));

// ─────────────── Error Handler ───────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal error", message: err.message });
});

// ─────────────── Start Server ───────────────
const PORT = process.env.PORT || 10000;
const HOST = "0.0.0.0";
const ENV = process.env.NODE_ENV || "development";

app.listen(PORT, HOST, () => {
  console.log(`✅ FinanceTubeAI API v3.4.0 running on ${HOST}:${PORT}`);
  console.log(`🌍 Environment: ${ENV}`);
  console.log(`📁 Temp: ${TMP_DIR}`);
  console.log(`📁 Videos: ${VIDEO_DIR}`);
  console.log(`🎨 Features: Dynamic captions, optimized quality`);
});
