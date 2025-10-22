import express from "express";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

// ---------- SETUP ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({ limit: "80mb" }));

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
  res.status(200).send("✅ FFmpeg Video API v2.2_Stable_Render_Fix is live and healthy!");
});

// ---------- HELPER: Run Command ----------
function runCommand(cmd, timeout = 240000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || err.message));
      resolve(stdout || stderr);
    });
  });
}

// ---------- MAIN /api/merge ----------
app.post("/api/merge", async (req, res) => {
  try {
    console.log("📩 Received /api/merge request");
    const { audio, image } = req.body;

    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const id = uuidv4();

    // detect image extension
    const imgBuf = Buffer.from(image, "base64");
    const ext = imgBuf[0] === 0x89 && imgBuf[1] === 0x50 ? ".png" : ".jpg";

    const imagePath = path.join(TMP_DIR, `${id}${ext}`);
    const audioPath = path.join(TMP_DIR, `${id}.mp3`);
    const wavPath = path.join(TMP_DIR, `${id}.wav`);
    const outputPath = path.join(TMP_DIR, `${id}-output.mp4`);

    fs.writeFileSync(imagePath, imgBuf);
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    console.log(`✅ Wrote temp files: ${path.basename(imagePath)}, ${path.basename(audioPath)}`);

    // ---------- Convert MP3 → WAV ----------
    const convertCmd = `ffmpeg -y -hide_banner -loglevel warning -i "${audioPath}" -ar 44100 -ac 2 "${wavPath}"`;
    console.log("🎧 Converting MP3 to WAV...");
    await runCommand(convertCmd, 60000);

    // ---------- Render Video ----------
    const renderCmd = `ffmpeg -y -hide_banner -loglevel warning -analyzeduration 100M -probesize 100M \
-fflags +igndts -loop 1 -i "${imagePath}" -i "${wavPath}" \
-vf "scale=1080:1920:force_original_aspect_ratio=decrease,format=yuv420p" \
-c:v libx264 -preset superfast -tune stillimage \
-c:a aac -b:a 128k -pix_fmt yuv420p -shortest -movflags +faststart "${outputPath}"`;

    console.log("🎬 Running FFmpeg command...");
    await runCommand(renderCmd, 180000);

    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg output not created");

    console.log("✅ FFmpeg finished successfully");

    const host = process.env.RENDER_EXTERNAL_HOSTNAME || req.get("host");
    const fileUrl = `https://${host}/${path.basename(outputPath)}`;

    res.json({ video_url: fileUrl });

    // ---------- Cleanup after 45s ----------
    setTimeout(() => {
      try {
        [imagePath, audioPath, wavPath, outputPath].forEach(f => {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        });
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

// ---------- STATIC SERVE ----------
app.use(express.static(TMP_DIR));

// ---------- SERVER START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ FFmpeg API running on port ${PORT}`);
});
