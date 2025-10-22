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

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
  res.status(200).send("✅ FFmpeg Video API is live and healthy!");
});

// ---------- MERGE ROUTE ----------
app.post("/api/merge", async (req, res) => {
  try {
    console.log("📩 Received merge request");
    const { audio, image } = req.body;
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const id = uuidv4();

    // Detect image type from signature
    const imgBuf = Buffer.from(image, "base64");
    let ext = ".jpg";
    if (imgBuf[0] === 0x89 && imgBuf[1] === 0x50) ext = ".png"; // PNG signature

    const imagePath = path.join(TMP_DIR, `${id}${ext}`);
    const audioPath = path.join(TMP_DIR, `${id}.mp3`);
    const outputPath = path.join(TMP_DIR, `${id}-output.mp4`);

    fs.writeFileSync(imagePath, imgBuf);
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    console.log(`✅ Files written: ${imagePath}, ${audioPath}`);

    // ✅ FIXED: use padding instead of cropping for any image size
    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" \
      -filter_complex "[0:v]scale=1080:-1[fg];[fg]boxblur=40:40[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2,scale=1080:-1,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
      -c:v libx264 -preset ultrafast -tune stillimage -c:a aac -b:a 128k \
      -pix_fmt yuv420p -shortest -movflags +faststart "${outputPath}"`;

    console.log("🎬 Running FFmpeg:", cmd);
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
        console.log(stdout || stderr);
        if (err) return reject(err);
        resolve();
      });
    });

    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg output not created.");

    console.log("✅ FFmpeg finished successfully");
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || "ffmpeg-video-api-ekkc.onrender.com";
    const fileUrl = `https://${host}/${path.basename(outputPath)}`;

    res.json({ video_url: fileUrl });

    // Cleanup after 45 seconds
    setTimeout(() => {
      try {
        [imagePath, audioPath, outputPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
        console.log("🧹 Cleaned temp files for", id);
      } catch (e) {
        console.error("Cleanup error:", e.message);
      }
    }, 45000);

  } catch (err) {
    console.error("💥 Merge error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- STATIC SERVE ----------
app.use(express.static(TMP_DIR));

// ---------- SERVER START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ FFmpeg Video API running on port ${PORT}`);
});
