// =====================================================
// FinanceTubeAI FFmpeg API v2.6.3_FreePlan_NonBlocking
// Author: Ramanananda V (FinanceTubeAI)
// Purpose: Render-safe, Free-tier 502-proof edition
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

// Health check
app.get("/", (req, res) => {
  res.send("✅ FFmpeg Video API v2.6.3_FreePlan_NonBlocking is running!");
});

// Async render
app.post("/api/merge", async (req, res) => {
  try {
    const { image, audio } = req.body;
    if (!image || !audio) return res.status(400).json({ error: "Missing audio or image base64." });

    const uid = uuidv4();
    const imgPath = path.join(TMP_DIR, `${uid}.png`);
    const mp3Path = path.join(TMP_DIR, `${uid}.mp3`);
    const wavPath = path.join(TMP_DIR, `${uid}.wav`);
    const outPath = path.join(VIDEO_DIR, `${uid}.mp4`);

    // Write temp files
    fs.writeFileSync(imgPath, Buffer.from(image, "base64"));
    fs.writeFileSync(mp3Path, Buffer.from(audio, "base64"));

    // Send immediate response to avoid Render timeout
    res.json({ status: "processing", video_id: uid, check_url: `/videos/${uid}.mp4` });

    // Background FFmpeg execution
    setTimeout(() => {
      const cmd = `
        ffmpeg -y -hide_banner -loglevel error \
        -i "${mp3Path}" -ar 44100 -ac 2 "${wavPath}" && \
        ffmpeg -y -hide_banner -loglevel error \
        -loop 1 -i "${imgPath}" -i "${wavPath}" \
        -vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
        -c:v libx264 -preset veryfast -tune stillimage \
        -c:a aac -b:a 128k -shortest -movflags +faststart "${outPath}"
      `;

      exec(cmd, (err) => {
        if (err) {
          console.error(`❌ Render error for ${uid}:`, err.message);
        } else {
          console.log(`✅ Render complete: ${outPath}`);
        }

        // Cleanup
        [imgPath, mp3Path, wavPath].forEach(f => {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        });
      });
    }, 100); // small delay to detach process

  } catch (err) {
    console.error("💥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve videos
app.use("/videos", express.static(path.join(process.cwd(), "public", "videos")));

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Free-tier Render-safe server on port ${PORT}`);
});
