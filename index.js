// =====================================================
// FinanceTubeAI FFmpeg API v2.6.4_FIXED_RaceCondition
// Author: Ramanananda V (FinanceTubeAI)
// Purpose: Fixed empty file issue with proper completion tracking
// =====================================================
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(cors());

const TMP_DIR = path.join(process.cwd(), "temp");
const VIDEO_DIR = path.join(process.cwd(), "public", "videos");

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

// Track video processing status
const videoStatus = new Map();

// Health check
app.get("/", (req, res) => {
  res.send("✅ FFmpeg Video API v2.6.4_FIXED is running!");
});

// Check video status
app.get("/api/status/:videoId", (req, res) => {
  const status = videoStatus.get(req.params.videoId);
  if (!status) {
    return res.status(404).json({ error: "Video not found" });
  }
  res.json(status);
});

// Async render with proper completion tracking
app.post("/api/merge", async (req, res) => {
  try {
    const { image, audio } = req.body;
    
    if (!image || !audio) {
      return res.status(400).json({ error: "Missing audio or image base64." });
    }

    const uid = uuidv4();
    const imgPath = path.join(TMP_DIR, `${uid}.png`);
    const mp3Path = path.join(TMP_DIR, `${uid}.mp3`);
    const wavPath = path.join(TMP_DIR, `${uid}.wav`);
    const outPath = path.join(VIDEO_DIR, `${uid}.mp4`);

    // Write temp files
    try {
      fs.writeFileSync(imgPath, Buffer.from(image, "base64"));
      fs.writeFileSync(mp3Path, Buffer.from(audio, "base64"));
      console.log(`✅ Files written for ${uid}`);
    } catch (err) {
      return res.status(500).json({ error: `File write failed: ${err.message}` });
    }

    // Set initial status
    videoStatus.set(uid, { status: "processing", progress: 0 });

    // Send immediate response
    res.json({ 
      status: "processing", 
      video_id: uid, 
      check_url: `/videos/${uid}.mp4`,
      status_url: `/api/status/${uid}`
    });

    // Background FFmpeg execution with completion tracking
    const cmd = `
      ffmpeg -y -hide_banner -loglevel error \
      -i "${mp3Path}" -ar 44100 -ac 2 "${wavPath}" && \
      ffmpeg -y -hide_banner -loglevel error \
      -loop 1 -i "${imgPath}" -i "${wavPath}" \
      -vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
      -c:v libx264 -preset veryfast -tune stillimage \
      -c:a aac -b:a 128k -shortest -movflags +faststart "${outPath}"
    `;

    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`❌ Render error for ${uid}:`, err.message);
        videoStatus.set(uid, { status: "error", error: err.message });
      } else {
        // ✅ CRITICAL FIX: Verify file exists and has content
        if (fs.existsSync(outPath)) {
          const stats = fs.statSync(outPath);
          console.log(`✅ Render complete: ${uid} (${Math.round(stats.size / 1024)} KB)`);
          
          if (stats.size > 0) {
            videoStatus.set(uid, { 
              status: "complete", 
              size: stats.size,
              url: `/videos/${uid}.mp4`
            });
          } else {
            console.error(`❌ Output file is 0 bytes for ${uid}`);
            videoStatus.set(uid, { status: "error", error: "Output file is empty" });
          }
        } else {
          console.error(`❌ Output file not found for ${uid}`);
          videoStatus.set(uid, { status: "error", error: "Output file not created" });
        }
      }

      // Cleanup temp files
      [imgPath, mp3Path, wavPath].forEach(f => {
        if (fs.existsSync(f)) {
          try {
            fs.unlinkSync(f);
          } catch (e) {
            console.error(`Cleanup error for ${f}:`, e.message);
          }
        }
      });

      // Auto-cleanup completed videos after 1 hour
      setTimeout(() => {
        if (fs.existsSync(outPath)) {
          try {
            fs.unlinkSync(outPath);
            videoStatus.delete(uid);
            console.log(`🗑️ Cleaned up ${uid}`);
          } catch (e) {
            console.error(`Cleanup error for ${uid}:`, e.message);
          }
        }
      }, 3600000); // 1 hour
    });

  } catch (err) {
    console.error("💥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve videos with proper headers
app.use("/videos", express.static(path.join(process.cwd(), "public", "videos"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.set({
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });
    }
  }
}));

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Fixed Render API on port ${PORT}`);
});
