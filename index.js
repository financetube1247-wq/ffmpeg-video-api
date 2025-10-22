// FinanceTubeAI — FFmpeg Video API v2.6_Stable_Final
// Author: Ramanananda V  |  Date: 2025-10-23
// Works seamlessly with Apps Script v3.7 / v3.8
// =============================================================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();

app.use(express.json({ limit: "20mb" }));
app.use(cors());

// ---------- Directories ----------
const TMP_DIR  = path.join(__dirname, "tmp");
const OUT_DIR  = path.join(__dirname, "public", "videos");
[ TMP_DIR, OUT_DIR ].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));

// ---------- Timestamp Helper ----------
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// =============================================================
// /api/merge — receives base64 {image, audio} → renders 1080×1920 MP4
// =============================================================
app.post("/api/merge", async (req, res) => {
  const id = uuidv4();
  const { image, audio } = req.body || {};

  if (!image || !audio)
    return res.status(400).json({ error: "Missing audio or image base64." });

  const imgPath = path.join(TMP_DIR, `${id}.png`);
  const mp3Path = path.join(TMP_DIR, `${id}.mp3`);
  const wavPath = path.join(TMP_DIR, `${id}.wav`);
  const outPath = path.join(OUT_DIR, `${id}.mp4`);

  try {
    console.log(`📩 [${stamp()}] Received /api/merge request for ${id}`);
    fs.writeFileSync(imgPath, Buffer.from(image, "base64"));
    fs.writeFileSync(mp3Path, Buffer.from(audio, "base64"));
    console.log(`✅ Temp files written: ${path.basename(imgPath)}, ${path.basename(mp3Path)}`);

    // ---------- 1️⃣ Validate MP3 ----------
    const mp3Size = fs.statSync(mp3Path).size;
    if (mp3Size < 20_000) throw new Error(`MP3 too small (${mp3Size} bytes)`);
    if (mp3Size > 1_000_000) console.warn(`⚠️ MP3 ≈ ${Math.round(mp3Size/1024)} KB — near limit`);

    let durationSec = 0;
    try {
      const d = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${mp3Path}"`
      ).toString().trim();
      durationSec = parseFloat(d) || 0;
      console.log(`🎧 MP3 duration: ${durationSec.toFixed(2)} s`);
    } catch {
      console.log("⚠️ Skipping duration probe");
    }
    if (durationSec < 0.5) throw new Error("MP3 duration < 0.5 s — likely corrupt");

    // ---------- 2️⃣ Convert to WAV ----------
    console.log("🎧 Converting MP3 → WAV...");
    execSync(
      `ffmpeg -y -hide_banner -loglevel warning -i "${mp3Path}" -ar 44100 -ac 2 -c:a pcm_s16le "${wavPath}"`
    );
    if (!fs.existsSync(wavPath)) throw new Error("WAV not created");
    const wavSize = fs.statSync(wavPath).size;
    if (wavSize < 20_000) throw new Error("Invalid WAV output (<20 KB)");

    // ---------- 3️⃣ Render Vertical MP4 ----------
    console.log("🎬 Rendering vertical video...");
    const cmd = [
      `ffmpeg -y -hide_banner -loglevel warning`,
      `-loop 1 -i "${imgPath}"`,
      `-i "${wavPath}"`,
      `-vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p"`,
      `-c:v libx264 -preset veryfast -tune stillimage`,
      `-c:a aac -b:a 128k -shortest -movflags +faststart`,
      `"${outPath}"`
    ].join(" ");
    execSync(cmd);
    if (!fs.existsSync(outPath)) throw new Error("MP4 not produced");

    console.log(`✅ Render complete for ${id}`);
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || req.get("host");
    const videoUrl = `https://${host}/videos/${path.basename(outPath)}`;
    res.json({ video_url: videoUrl });

    // ---------- Cleanup Temp ----------
    setTimeout(() => {
      [imgPath, mp3Path, wavPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    }, 15000);

  } catch (err) {
    console.error("💥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Health Check ----------
app.get("/", (_, res) =>
  res.send("✅ FFmpeg Video API v2.6_Stable_Final is running and healthy!")
);

// ---------- Static Output ----------
app.use("/videos", express.static(OUT_DIR));

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render API ready on port ${PORT}`));
