/********************************************************************
 FinanceTubeAI — FFmpeg Video API v2.3_FreeTierOptimized
 Author: Ramanananda V | Maintainer: FinanceTubeAI
 Purpose:
 - Lightweight, stable API for converting image + audio → MP4
 - Designed for free Render tier (under 1 MB inputs)
 - Handles automatic cleanup & health checks
*********************************************************************/

import express from "express";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

/* ---------------- SETUP ---------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({ limit: "80mb" }));

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (req, res) => {
  res.status(200).send("✅ FFmpeg Video API v2.3_FreeTierOptimized is live and healthy!");
});

/* ---------------- UTILITY ---------------- */
function runCommand(cmd, timeout = 240000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || err.message));
      resolve(stdout || stderr);
    });
  });
}

/* ---------------- MERGE ROUTE ---------------- */
app.post("/api/merge", async (req, res) => {
  try {
    console.log("📩 Received /api/merge request");

    const { audio, image } = req.body;
    if (!audio || !image) return res.status(400).json({ error: "Missing audio or image base64" });

    const id = uuidv4();
    const imgBuf = Buffer.from(image, "base64");
    const ext = imgBuf[0] === 0x89 && imgBuf[1] === 0x50 ? ".png" : ".jpg";

    const imagePath = path.join(TMP_DIR, `${id}${ext}`);
    const audioPath = path.join(TMP_DIR, `${id}.mp3`);
    const wavPath = path.join(TMP_DIR, `${id}.wav`);
    const outputPath = path.join(TMP_DIR, `${id}-output.mp4`);

    fs.writeFileSync(imagePath, imgBuf);
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    console.log(`✅ Temp files written: ${path.basename(imagePath)}, ${path.basename(audioPath)}`);

    /* ---- STEP 1: Convert MP3 → WAV ---- */
    const convertCmd = `ffmpeg -y -hide_banner -loglevel error -i "${audioPath}" -ar 44100 -ac 2 "${wavPath}"`;
    console.log("🎧 Converting MP3 to WAV...");
    await runCommand(convertCmd, 60000);

    /* ---- STEP 2: Compose final video ---- */
    // Adjusted for vertical 1080x1920, free-tier stable
    const renderCmd = `ffmpeg -y -hide_banner -loglevel error -loop 1 -i "${imagePath}" -i "${wavPath}" \
-vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
-c:v libx264 -preset veryfast -tune stillimage -c:a aac -b:a 128k \
-shortest -movflags +faststart "${outputPath}"`;

    console.log("🎬 Running FFmpeg render...");
    await runCommand(renderCmd, 180000);

    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg output not created.");
    console.log("✅ Render complete.");

    const host = process.env.RENDER_EXTERNAL_HOSTNAME || req.get("host");
    const fileUrl = `https://${host}/${path.basename(outputPath)}`;

    res.json({ video_url: fileUrl });

    /* ---- STEP 3: Cleanup after 45 s ---- */
    setTimeout(() => {
      try {
        [imagePath, audioPath, wavPath, outputPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
        console.log("🧹 Cleaned temp files for", id);
      } catch (e) {
        console.error("Cleanup error:", e.message);
      }
    }, 45000);

  } catch (err) {
    console.error("💥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- STATIC SERVE ---------------- */
app.use(express.static(TMP_DIR));

/* ---------------- SERVER START ---------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ FFmpeg Video API v2.3_FreeTierOptimized running on port ${PORT}`);
});
