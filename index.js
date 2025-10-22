// ============================================================================
// FinanceTubeAI — FFmpeg Video API v2.5_MemorySafe_RenderFix
// Author: Ramanananda V | Date: 2025-10-23
// Compatible with Apps Script v3.7_STAGED_IDEMPOTENT_SAFE
// ============================================================================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

const TMP = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

// Small helper to log time stamps
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// ================================================================
// /api/merge — base64 image + audio  → vertical 1080x1920 video
// ================================================================
app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image } = req.body;
    if (!audio || !image) return res.status(400).json({ error: "Missing audio or image base64." });

    const uid = uuidv4();
    const imgPath = path.join(TMP, `${uid}.png`);
    const mp3Path = path.join(TMP, `${uid}.mp3`);
    const wavPath = path.join(TMP, `${uid}.wav`);
    const outPath = path.join(TMP, `${uid}-output.mp4`);

    console.log(`📩 [${stamp()}] Received /api/merge request for ${uid}`);
    fs.writeFileSync(imgPath, Buffer.from(image, "base64"));
    fs.writeFileSync(mp3Path, Buffer.from(audio, "base64"));
    console.log(`✅ Temp files written: ${path.basename(imgPath)}, ${path.basename(mp3Path)}`);

    // ---------- 1️⃣ Verify MP3 before conversion ----------
    const mp3Size = fs.statSync(mp3Path).size;
    if (mp3Size < 20000) throw new Error(`MP3 too small (${mp3Size} bytes)`);
    if (mp3Size > 1_000_000) console.warn(`⚠️ MP3 ${Math.round(mp3Size / 1024)}KB — near limit`);

    // Quick duration check
    let durationSec = 0;
    try {
      const d = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${mp3Path}"`).toString().trim();
      durationSec = parseFloat(d) || 0;
      console.log(`🎧 MP3 duration: ${durationSec.toFixed(2)}s`);
    } catch { console.log("⚠️ Skipping duration probe"); }

    if (durationSec < 0.5) throw new Error("MP3 duration < 0.5s — likely corrupt");

    // ---------- 2️⃣ Convert to WAV ----------
    console.log("🎧 Converting MP3 → WAV...");
    execSync(`ffmpeg -y -hide_banner -loglevel error -i "${mp3Path}" -ar 44100 -ac 2 "${wavPath}"`);
    if (!fs.existsSync(wavPath)) throw new Error("WAV not created");
    const wavSize = fs.statSync(wavPath).size;
    if (wavSize < 20000) throw new Error("Invalid WAV output (<20KB)");

    // ---------- 3️⃣ Render to vertical MP4 ----------
    console.log("🎬 Rendering vertical video...");
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
    const b64 = fs.readFileSync(outPath).toString("base64");
    res.json({ video_url: `data:video/mp4;base64,${b64}` });

    // Clean up async
    setTimeout(() => [imgPath, mp3Path, wavPath, outPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f)), 15000);
  } catch (err) {
    console.error("💥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health
app.get("/", (_, res) => res.send("✅ FFmpeg Video API v2.5_MemorySafe_RenderFix is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render API ready on port ${PORT}`));
