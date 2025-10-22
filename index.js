// ============================================================================
// FinanceTubeAI — FFmpeg Video API v2.6.2_Stable_Final_No502
// Author: Ramanananda V | Date: 2025-10-23
// Safe for Render.com & Apps Script v3.7 Integration
// ============================================================================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

// ----------------------------------------------------
// Setup and Environment
// ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(cors());

// ----------------------------------------------------
// Folder Structure
// ----------------------------------------------------
const TMP = path.join(__dirname, "tmp");
const OUT_DIR = path.join(__dirname, "public", "videos");

// Auto-create directories if missing
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Serve rendered videos publicly
app.use("/videos", express.static(OUT_DIR));

// Small helper for timestamped logging
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// ----------------------------------------------------
// /api/merge — combines base64 audio + image → 1080x1920 video
// ----------------------------------------------------
app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image } = req.body;
    if (!audio || !image) return res.status(400).json({ error: "Missing audio or image base64." });

    const uid = uuidv4();
    const imgPath = path.join(TMP, `${uid}.png`);
    const mp3Path = path.join(TMP, `${uid}.mp3`);
    const wavPath = path.join(TMP, `${uid}.wav`);
    const outPath = path.join(OUT_DIR, `${uid}.mp4`);

    console.log(`📩 [${stamp()}] Received /api/merge request for ${uid}`);

    // Write input files
    fs.writeFileSync(imgPath, Buffer.from(image, "base64"));
    fs.writeFileSync(mp3Path, Buffer.from(audio, "base64"));
    console.log(`✅ Temp files written: ${path.basename(imgPath)}, ${path.basename(mp3Path)}`);

    // Validate MP3
    const mp3Size = fs.statSync(mp3Path).size;
    if (mp3Size < 20000) throw new Error(`MP3 too small (${mp3Size} bytes)`);
    if (mp3Size > 1_000_000) console.warn(`⚠️ MP3 ${Math.round(mp3Size / 1024)}KB — near 1 MB limit`);

    // Duration check
    let durationSec = 0;
    try {
      const d = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${mp3Path}"`).toString().trim();
      durationSec = parseFloat(d) || 0;
      console.log(`🎧 MP3 duration: ${durationSec.toFixed(2)}s`);
    } catch {
      console.log("⚠️ Duration probe skipped");
    }

    if (durationSec < 0.5) throw new Error("MP3 duration < 0.5s — likely corrupt");

    // Convert MP3 → WAV
    console.log("🎧 Converting MP3 → WAV...");
    execSync(`ffmpeg -y -hide_banner -loglevel error -i "${mp3Path}" -ar 44100 -ac 2 "${wavPath}"`);
    if (!fs.existsSync(wavPath)) throw new Error("WAV not created");

    const wavSize = fs.statSync(wavPath).size;
    if (wavSize < 20000) throw new Error("Invalid WAV output (<20KB)");

    // Render vertical MP4
    console.log("🎬 Rendering 1080x1920 vertical video...");
    const cmd = [
      `ffmpeg -y -hide_banner -loglevel error`,
      `-loop 1 -i "${imgPath}"`,
      `-i "${wavPath}"`,
      `-vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p"`,
      `-c:v libx264 -preset veryfast -tune stillimage`,
      `-c:a aac -b:a 128k -shortest -movflags +faststart`,
      `"${outPath}"`
    ].join(" ");

    execSync(cmd);
    if (!fs.existsSync(outPath)) throw new Error("MP4 not produced");

    console.log(`✅ Render complete for ${uid}`);
    const videoUrl = `${req.protocol}://${req.get("host")}/videos/${uid}.mp4`;
    res.json({ video_url: videoUrl });

    // Cleanup temporary files (keep mp4)
    setTimeout(() => {
      [imgPath, mp3Path, wavPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    }, 10_000);

  } catch (err) {
    console.error("💥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// Health Route
// ----------------------------------------------------
app.get("/", (_, res) => {
  res.send("✅ FFmpeg Video API v2.6.2_Stable_Final_No502 is running and healthy!");
});

// ----------------------------------------------------
// Start Server
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Render API ready on port ${PORT}`);
});
