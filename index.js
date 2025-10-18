/**
 * FinanceTubeAI FFmpeg Merge API (Render-safe)
 * --------------------------------------------
 * This microservice merges an image + audio into an MP4 video using FFmpeg.
 * It uses @ffmpeg-installer/ffmpeg to ensure the ffmpeg binary is available
 * even in Render or other containerized environments.
 */

import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 10000;
const TMP_DIR = join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

/**
 * POST /api/merge
 * Expects:
 * {
 *   "audio": "<base64-audio>",
 *   "image": "<base64-image>",
 *   "filename": "video.mp4"
 * }
 */
app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image, filename } = req.body;
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image" });
    }

    const id = uuidv4();
    const audioPath = join(TMP_DIR, `${id}-audio.mp3`);
    const imagePath = join(TMP_DIR, `${id}-image.jpg`);
    const outputPath = join(TMP_DIR, `${id}-${filename || "output.mp4"}`);

    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));

    const ffmpegArgs = [
      "-loop", "1",
      "-i", imagePath,
      "-i", audioPath,
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-shortest",
      "-movflags", "faststart",
      outputPath
    ];

    const ffmpeg = spawn(ffmpegPath.path, ffmpegArgs);

    let stderrData = "";
    ffmpeg.stderr.on("data", d => (stderrData += d.toString()));

    ffmpeg.on("close", code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        const videoBuffer = fs.readFileSync(outputPath);
        const videoBase64 = videoBuffer.toString("base64");
        res.json({ success: true, videoBase64 });
      } else {
        console.error("❌ FFmpeg merge failed:", stderrData);
        res.status(500).json({ error: "FFmpeg merge failed", log: stderrData });
      }

      // Cleanup temporary files
      [audioPath, imagePath, outputPath].forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
    });

  } catch (err) {
    console.error("❌ API error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.send("✅ FFmpeg API is running. Use POST /api/merge");
});

app.listen(PORT, () => {
  console.log(`🎬 FFmpeg API running on port ${PORT}`);
});
