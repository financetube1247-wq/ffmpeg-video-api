import express from "express";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({ limit: "80mb" }));

const TMP_DIR = path.join(__dirname, "tmp");
const OUT_DIR = path.join(__dirname, "public", "videos");
[ TMP_DIR, OUT_DIR ].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => res.status(200).send("✅ FFmpeg Video API v2.3_Stable_SafeAudio is live and healthy!"));

// ---------- UTILITY ----------
function runCommand(cmd, timeout = 240000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || err.message));
      resolve(stdout || stderr);
    });
  });
}

// ---------- MERGE ----------
app.post("/api/merge", async (req, res) => {
  const id = uuidv4();
  const imageB64 = req.body.image;
  const audioB64 = req.body.audio;

  if (!audioB64 || !imageB64)
    return res.status(400).json({ error: "Missing audio or image base64" });

  const imgBuf = Buffer.from(imageB64, "base64");
  const ext = imgBuf[0] === 0x89 && imgBuf[1] === 0x50 ? ".png" : ".jpg";

  const imagePath = path.join(TMP_DIR, `${id}${ext}`);
  const audioPath = path.join(TMP_DIR, `${id}.mp3`);
  const wavPath   = path.join(TMP_DIR, `${id}.wav`);
  const outputPath = path.join(OUT_DIR, `${id}.mp4`);

  try {
    console.log(`📩 [${new Date().toISOString()}] Received /api/merge request for ${id}`);
    fs.writeFileSync(imagePath, imgBuf);
    fs.writeFileSync(audioPath, Buffer.from(audioB64, "base64"));
    console.log(`✅ Temp files written: ${path.basename(imagePath)}, ${path.basename(audioPath)}`);

    // Step 1: probe duration (optional, for log)
    try {
      const durOut = await runCommand(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
      console.log(`🎧 MP3 duration: ${parseFloat(durOut).toFixed(2)}s`);
    } catch {}

    // Step 2: Convert MP3 to WAV safely
    console.log("🎧 Converting MP3 → WAV...");
    await runCommand(`ffmpeg -y -hide_banner -loglevel warning -i "${audioPath}" -ar 44100 -ac 2 -c:a pcm_s16le "${wavPath}"`);

    // Step 3: Main render
    console.log("🎬 Rendering vertical video...");
    await runCommand(`ffmpeg -y -hide_banner -loglevel warning \
      -loop 1 -i "${imagePath}" -i "${wavPath}" \
      -vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
      -c:v libx264 -preset veryfast -tune stillimage -c:a aac -b:a 128k \
      -shortest -movflags +faststart "${outputPath}"`);

    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg output not created.");

    console.log(`✅ Render complete for ${id}`);
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || req.get("host");
    const videoUrl = `https://${host}/videos/${path.basename(outputPath)}`;
    res.json({ video_url: videoUrl });

  } catch (err) {
    console.error("💥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup temp files always
    setTimeout(() => {
      [imagePath, audioPath, wavPath].forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
    }, 20000);
  }
});

// ---------- STATIC SERVE ----------
app.use("/videos", express.static(OUT_DIR));

// ---------- SERVER START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ FFmpeg Video API running on port ${PORT}`));
