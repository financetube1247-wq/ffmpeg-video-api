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
app.use(express.json({ limit: "50mb" }));

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// helper
function run(cmd, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr) console.log(stderr);
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------- HEALTH ----------
app.get("/", (_req, res) => {
  res.status(200).send("✅ FFmpeg Video API is live and healthy!");
});

// ---------- MERGE (robust portrait) ----------
app.post("/api/merge", async (req, res) => {
  const started = Date.now();
  try {
    console.log("📩 Received /api/merge request");
    const { audio, image } = req.body || {};
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    const id = uuidv4();
    const audioMp3Path = path.join(TMP_DIR, `${id}.mp3`);
    const audioWavPath = path.join(TMP_DIR, `${id}.wav`);

    // Detect image type (PNG vs JPEG) by header bytes
    const imgBuf = Buffer.from(image, "base64");
    let imgExt = ".jpg";
    if (imgBuf[0] === 0x89 && imgBuf[1] === 0x50 && imgBuf[2] === 0x4e && imgBuf[3] === 0x47) {
      imgExt = ".png";
    }
    const imagePath = path.join(TMP_DIR, `${id}${imgExt}`);
    const outputPath = path.join(TMP_DIR, `${id}-output.mp4`);

    fs.writeFileSync(imagePath, imgBuf);
    fs.writeFileSync(audioMp3Path, Buffer.from(audio, "base64"));
    console.log(`✅ Wrote temp files: ${path.basename(imagePath)}, ${path.basename(audioMp3Path)}`);

    // STEP 1: Convert MP3 -> WAV (fixes duration ambiguity)
    // 44.1kHz stereo WAV is easy for ffmpeg to reason about
    const toWavCmd = `ffmpeg -y -hide_banner -loglevel warning -i "${audioMp3Path}" -ar 44100 -ac 2 "${audioWavPath}"`;
    console.log("🎧 Converting MP3 to WAV:", toWavCmd);
    await run(toWavCmd);

    // STEP 2: Safe portrait composition (no crops that can fail)
    // Strategy: scale width to 1080, keep AR, then pad to 1080x1920 centered.
    // Works for square, landscape, and portrait sources.
    const mergeCmd =
      `ffmpeg -y -hide_banner -loglevel warning -loop 1 -i "${imagePath}" -i "${audioWavPath}" ` +
      `-vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" ` +
      `-c:v libx264 -preset veryfast -tune stillimage -c:a aac -b:a 128k ` +
      `-pix_fmt yuv420p -shortest -movflags +faststart "${outputPath}"`;
    console.log("🎬 Running FFmpeg:", mergeCmd);
    await run(mergeCmd, 300000);

    if (!fs.existsSync(outputPath)) {
      throw new Error("FFmpeg did not produce output file.");
    }

    console.log("✅ FFmpeg finished:", path.basename(outputPath));

    const host =
      process.env.RENDER_EXTERNAL_HOSTNAME ||
      process.env.RENDER_INTERNAL_HOSTNAME ||
      req.get("host") ||
      "localhost:" + (process.env.PORT || 10000);

    const fileUrl =
      (host.startsWith("http") ? "" : "https://") + host + "/" + path.basename(outputPath);

    res.json({ video_url: fileUrl, ms: Date.now() - started });

    // Cleanup later
    setTimeout(() => {
      try {
        [imagePath, audioMp3Path, audioWavPath, outputPath].forEach(f => {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        });
        console.log("🧹 Cleaned temp files for", id);
      } catch (e) {
        console.error("Cleanup error:", e.message);
      }
    }, 60000);

  } catch (err) {
    console.error("💥 Merge error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- STATIC ----------
app.use(express.static(TMP_DIR));

// ---------- SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ FFmpeg Video API running on port ${PORT}`);
});
