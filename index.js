// =====================================================
// FILE: index.js (FinanceTubeAI Render API v3.3.1-FINAL)
// PURPOSE: Merge image + audio into vertical YouTube Shorts-ready MP4
// COMPATIBLE WITH: Apps Script v3.9.1 (FinanceTubeAI_ShortsAutomation)
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
const TMP_DIR = path.join(process.cwd(), "temp");
const VIDEO_DIR = path.join(process.cwd(), "public", "videos");
[TMP_DIR, VIDEO_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

// ─────────────── Job Tracking ───────────────
const videoJobs = new Map();
const MAX_JOB_AGE = 3600000;      // 1 hour
const MAX_ACTIVE_JOBS = 100;      // memory protection

// ─────────────── Cleanup Function ───────────────
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

  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old jobs and videos`);

  // Memory protection
  if (videoJobs.size > MAX_ACTIVE_JOBS) {
    const excess = videoJobs.size - MAX_ACTIVE_JOBS;
    const oldest = Array.from(videoJobs.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, excess);
    oldest.forEach(([id]) => videoJobs.delete(id));
    console.log(`⚠️ Purged ${excess} oldest jobs to maintain memory limits`);
  }
}
setInterval(cleanupOldJobs, 900000); // every 15 min

// ─────────────── Routes ───────────────
app.get("/", (req, res) =>
  res.json({ status: "online", version: "3.3.1", uptime: Math.floor(process.uptime()) })
);

// Health check
app.get("/health", (req, res) => {
  try {
    const mem = process.memoryUsage();
    res.json({
      status: "healthy",
      version: "3.3.1",
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + "MB",
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + "MB",
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + "MB",
      },
      jobs: {
        active: videoJobs.size,
        processing: [...videoJobs.values()].filter(j => j.status === "processing").length,
        completed: [...videoJobs.values()].filter(j => j.status === "complete").length,
        errors: [...videoJobs.values()].filter(j => j.status === "error").length,
      },
      files: {
        temp: fs.readdirSync(TMP_DIR).length,
        videos: fs.readdirSync(VIDEO_DIR).length,
      },
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// Merge API (core endpoint)
app.post("/api/merge", async (req, res) => {
  try {
    const { image, audio } = req.body;
    if (!image || !audio)
      return res.status(400).json({
        error: "Missing base64 image or audio",
        received: { hasImage: !!image, hasAudio: !!audio },
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
      return res.status(400).json({ error: "Invalid base64 encoding", details: e.message });
    }

    const imgKB = Math.round(imgBuffer.length / 1024);
    const audKB = Math.round(audBuffer.length / 1024);
    console.log(`📦 Job ${id}: image=${imgKB}KB audio=${audKB}KB`);

    if (imgBuffer.length < 1000 || audBuffer.length < 1000)
      return res.status(400).json({ error: "Input file too small" });

    fs.writeFileSync(imgPath, imgBuffer);
    fs.writeFileSync(audPath, audBuffer);

    videoJobs.set(id, {
      status: "processing",
      createdAt: Date.now(),
      imageSizeKB: imgKB,
      audioSizeKB: audKB,
    });

    const base = `${req.protocol}://${req.get("host")}`;
    res.json({
      status: "processing",
      video_id: id,
      check_url: `${base}/videos/${id}.mp4`,
      status_url: `${base}/api/status/${id}`,
    });

    processVideo(id, imgPath, audPath, outPath).catch(err =>
      console.error(`❌ Background process ${id}:`, err.message)
    );
  } catch (error) {
    console.error("❌ Merge API error:", error);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

// Job status
app.get("/api/status/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job)
    return res.status(404).json({ error: "Job not found", id: req.params.id });
  res.json({ id: req.params.id, ...job, age: Math.floor((Date.now() - job.createdAt) / 1000) + "s" });
});

// ─────────────── Core Processing ───────────────
async function processVideo(id, imgPath, audPath, outPath) {
  const started = Date.now();
  try {
    console.log(`🎬 Processing ${id}`);
    const cmd = `
      ffmpeg -y -hide_banner -loglevel warning \
      -loop 1 -framerate 1 -i "${imgPath}" \
      -i "${audPath}" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1:1,format=yuv420p" \
      -c:v libx264 -pix_fmt yuv420p -preset ultrafast -tune stillimage -crf 28 \
      -c:a aac -b:a 128k -ar 44100 \
      -shortest -movflags +faststart \
      -max_muxing_queue_size 1024 \
      -threads 1 -avoid_negative_ts make_zero \
      "${outPath}"
    `.trim().replace(/\s+/g, " ");

    console.log(`▶️ Executing FFmpeg for ${id}...`);
    const { stderr } = await execPromise(cmd, { timeout: 420000 });
    if (stderr) console.log(`⚠️ FFmpeg stderr for ${id}:`, stderr.slice(0, 500));

    if (!fs.existsSync(outPath)) throw new Error("Output file was not created");
    const stats = fs.statSync(outPath);
    const sizeKB = Math.round(stats.size / 1024);
    if (stats.size < 150000) throw new Error(`Output too small (${stats.size} bytes)`);

    videoJobs.set(id, {
      status: "complete",
      videoId: id,
      size: stats.size,
      sizeKB,
      url: `/videos/${id}.mp4`,
      processingTime: Math.round((Date.now() - started) / 1000),
      createdAt: videoJobs.get(id).createdAt,
    });
    console.log(`✅ ${id} ready (${sizeKB}KB)`);
  } catch (e) {
    console.error(`❌ Processing failed for ${id}:`, e.message);
    videoJobs.set(id, {
      status: "error",
      error: e.message,
      stderr: e.stderr ? e.stderr.slice(0, 500) : undefined,
      createdAt: videoJobs.get(id)?.createdAt || Date.now(),
    });
    if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch {}
  } finally {
    [imgPath, audPath].forEach(f => { if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {} });
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
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Access-Control-Allow-Origin": "*",
        });
      } catch (e) {
        console.error("Header error:", e.message);
      }
    }
  },
}));

// ─────────────── Global Error Handling ───────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// ─────────────── Start Server ───────────────
const PORT = process.env.PORT || 10000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`✅ FFmpeg Video API v3.3.1-FINAL running on ${HOST}:${PORT}`);
  console.log(`📁 Temp directory: ${TMP_DIR}`);
  console.log(`📁 Video directory: ${VIDEO_DIR}`);
  console.log(`🔄 Cleanup interval: 15 minutes`);
  console.log(`⏱️ Job max age: ${MAX_JOB_AGE / 60000} minutes`);
  console.log(`🔒 Max active jobs: ${MAX_ACTIVE_JOBS}`);
  console.log(`⏳ FFmpeg timeout: 7 minutes`);
});
