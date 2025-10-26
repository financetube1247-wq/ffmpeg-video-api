// =====================================================
// FILE: index.js (FinanceTubeAI Render API v3.3.3-PERSISTENT)
// ENHANCEMENTS:
// - Fixed path issues for VIDEO_DIR
// - Added flush delay for file write completion
// - Added /debug/videos route for troubleshooting
// - Caption overlay retained from v3.3.2
// =====================================================

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";

const execPromise = promisify(exec);
const app = express();

// ─────────────── Middleware ───────────────
app.use(express.json({ limit: "100mb" }));
app.use(cors());

// ─────────────── Directories ───────────────
const TMP_DIR = path.resolve("temp");
const VIDEO_DIR = path.resolve("public/videos");
[TMP_DIR, VIDEO_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
console.log("📁 TMP_DIR:", TMP_DIR);
console.log("📁 VIDEO_DIR:", VIDEO_DIR);

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
          console.error(`Cleanup error for ${id}:`, e.message);
        }
      }
    }
  }

  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old jobs`);
}
setInterval(cleanupOldJobs, 900000);

// ─────────────── Routes ───────────────
app.get("/", (req, res) =>
  res.json({ status: "online", version: "3.3.3-PERSISTENT", uptime: Math.floor(process.uptime()) })
);

app.get("/health", (req, res) => {
  try {
    const mem = process.memoryUsage();
    res.json({
      status: "healthy",
      version: "3.3.3-PERSISTENT",
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + "MB",
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + "MB"
      },
      jobs: {
        active: videoJobs.size,
        complete: [...videoJobs.values()].filter(j => j.status === "complete").length
      },
      files: fs.readdirSync(VIDEO_DIR)
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// ─────────────── Merge API ───────────────
app.post("/api/merge", async (req, res) => {
  try {
    const { image, audio, caption } = req.body;
    if (!image || !audio)
      return res.status(400).json({ error: "Missing base64 image or audio" });

    const id = uuidv4();
    const imgPath = path.join(TMP_DIR, `${id}.jpg`);
    const audPath = path.join(TMP_DIR, `${id}.mp3`);
    const outPath = path.join(VIDEO_DIR, `${id}.mp4`);

    fs.writeFileSync(imgPath, Buffer.from(image, "base64"));
    fs.writeFileSync(audPath, Buffer.from(audio, "base64"));

    videoJobs.set(id, {
      status: "processing",
      createdAt: Date.now(),
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
      console.error(`❌ Background process ${id}:`, err.message)
    );
  } catch (err) {
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ─────────────── Job Status ───────────────
app.get("/api/status/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job)
    return res.status(404).json({ error: "Job not found", id: req.params.id });
  res.json({ id: req.params.id, ...job });
});

// ─────────────── Core Processing ───────────────
async function processVideo(id, imgPath, audPath, outPath, caption) {
  const started = Date.now();
  try {
    console.log(`🎬 Processing ${id}`);
    const overlayText = (caption || "FinanceTubeAI Shorts").replace(/"/g, '\\"');

    const vfFilter = `
      [0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[a];
      [a]format=yuv420p,drawtext=text='${overlayText}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h-200:shadowcolor=black:shadowx=2:shadowy=2
    `.trim().replace(/\n/g, "");

    const cmd = `
      ffmpeg -y -hide_banner -loglevel warning \
      -loop 1 -framerate 1 -i "${imgPath}" \
      -i "${audPath}" \
      -vf "${vfFilter}" \
      -c:v libx264 -pix_fmt yuv420p -preset veryfast -tune stillimage -crf 23 \
      -c:a aac -b:a 128k -ar 44100 \
      -shortest -movflags +faststart \
      -threads 1 -avoid_negative_ts make_zero \
      "${outPath}"
    `.trim().replace(/\s+/g, " ");

    console.log(`▶️ Executing FFmpeg for ${id}...`);
    await execPromise(cmd, { timeout: 420000 });

    // Wait 2s for file flush
    await new Promise(r => setTimeout(r, 2000));

    if (!fs.existsSync(outPath))
      throw new Error("Output file was not created or not flushed");

    const stats = fs.statSync(outPath);
    const sizeKB = Math.round(stats.size / 1024);
    if (sizeKB < 150)
      throw new Error(`Output too small (${sizeKB}KB)`);

    videoJobs.set(id, {
      status: "complete",
      videoId: id,
      sizeKB,
      url: `/videos/${id}.mp4`,
      caption: overlayText,
      processingTime: Math.round((Date.now() - started) / 1000),
      createdAt: videoJobs.get(id).createdAt
    });
    console.log(`✅ ${id} ready (${sizeKB}KB)`);

  } catch (e) {
    console.error(`❌ Processing failed for ${id}:`, e.message);
    videoJobs.set(id, { status: "error", error: e.message });
    if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch {}
  } finally {
    [imgPath, audPath].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  }
}

// ─────────────── Serve Videos ───────────────
app.use("/videos", express.static(VIDEO_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) {
      const stats = fs.statSync(filePath);
      res.set({
        "Content-Type": "video/mp4",
        "Content-Length": stats.size,
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Access-Control-Allow-Origin": "*"
      });
    }
  }
}));

// Debug route to check saved files
app.get("/debug/videos", (req, res) => {
  const files = fs.readdirSync(VIDEO_DIR);
  res.json({ videoDir: VIDEO_DIR, files });
});

// ─────────────── Global Error Handling ───────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// ─────────────── Start Server ───────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ FFmpeg Video API v3.3.3-PERSISTENT running on port ${PORT}`);
  console.log(`⏳ Cleanup interval: 15 minutes`);
});
