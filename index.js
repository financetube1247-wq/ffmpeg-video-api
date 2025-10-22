// ============================================================================
// Fiducia Fintech / FinanceTubeAI FFmpeg Video Merge API (Stable v3.0)
// ============================================================================
// Features:
//  • Accepts either base64 or direct URLs for image/audio
//  • Automatically detects audio duration (uses ffprobe fallback 60s)
//  • Generates short MP4 videos for YouTube Shorts automation
//  • Returns a downloadable public URL
//  • Safe temp cleanup, detailed logs for debugging
// ============================================================================

import express from "express";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";
import { spawn, execSync } from "child_process";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;
const TMP_DIR = "/opt/render/project/src/tmp";

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.static(TMP_DIR));

app.get("/", (req, res) => res.send("✅ FFmpeg Video API running."));

app.post("/api/merge", async (req, res) => {
  try {
    console.log("📩 Received merge request");

    const { topic, script, audio, image, audioUrl, imageUrl } = req.body;
    if ((!audio && !audioUrl) || (!image && !imageUrl)) {
      console.error("❌ Missing audio or image data");
      return res.status(400).json({ error: "Missing audio or image base64/url" });
    }

    // Step 1 — create temporary file names
    const uid = crypto.randomUUID();
    const imgPath = path.join(TMP_DIR, `${uid}.jpg`);
    const audPath = path.join(TMP_DIR, `${uid}.mp3`);
    const outPath = path.join(TMP_DIR, `${uid}-output.mp4`);

    // Step 2 — save files
    if (image) {
      fs.writeFileSync(imgPath, Buffer.from(image, "base64"));
    } else if (imageUrl) {
      const imgBuf = await fetch(imageUrl).then(r => r.arrayBuffer());
      fs.writeFileSync(imgPath, Buffer.from(imgBuf));
    }

    if (audio) {
      fs.writeFileSync(audPath, Buffer.from(audio, "base64"));
    } else if (audioUrl) {
      const audBuf = await fetch(audioUrl).then(r => r.arrayBuffer());
      fs.writeFileSync(audPath, Buffer.from(audBuf));
    }

    console.log("✅ Files saved locally");

    // Step 3 — detect duration
    let duration = 60;
    try {
      const probe = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${audPath}"`).toString().trim();
      duration = Math.ceil(parseFloat(probe)) || 60;
    } catch (e) {
      console.log("⚠️ ffprobe failed, using fallback duration 60s");
    }

    console.log(`🎬 Detected duration: ${duration}s`);

    // Step 4 — run FFmpeg
    const ffmpegArgs = [
      "-loop", "1",
      "-i", imgPath,
      "-i", audPath,
      "-t", duration.toString(),
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-shortest",
      "-movflags", "faststart",
      outPath
    ];

    console.log("🎥 Running FFmpeg with:", ffmpegArgs.join(" "));

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stderr.on("data", d => process.stdout.write(d.toString()));

    ffmpeg.on("close", (code) => {
      console.log(`✅ FFmpeg finished with code ${code}`);
      if (fs.existsSync(outPath)) {
        const videoUrl = `${req.protocol}://${req.get("host")}/${path.basename(outPath)}`;
        console.log("✅ Returning video:", videoUrl);
        return res.json({ video_url: videoUrl });
      } else {
        return res.status(500).json({ error: "Output file missing after FFmpeg." });
      }
    });

    // Timeout safety — if ffmpeg stalls
    setTimeout(() => {
      if (!res.headersSent) {
        console.error("⏰ Timeout — FFmpeg took too long");
        res.status(504).json({ error: "Timeout during rendering" });
      }
    }, (duration + 30) * 1000);

  } catch (err) {
    console.error("💥 Merge error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ FFmpeg Video API running on port ${PORT}`);
});
