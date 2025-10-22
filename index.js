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
app.use(express.json({ limit: "50mb" }));

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

app.get("/", (req, res) => {
  res.status(200).send("✅ FFmpeg Video API running.");
});

app.post("/api/merge", async (req, res) => {
  try {
    console.log("📩 Received merge request");
    const { audio, image } = req.body;
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    // Ensure /tmp folder always exists
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

    const id = uuidv4();
    const audioPath = path.join(TMP_DIR, `${id}.mp3`);
    const imagePath = path.join(TMP_DIR, `${id}.jpg`);
    const outputPath = path.join(TMP_DIR, `${id}-output.mp4`);

    // Decode base64 and write files
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));
    console.log("✅ Files written:", { audioPath, imagePath });

    // Build ffmpeg command
    const cmd = `ffmpeg -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -movflags faststart "${outputPath}"`;

    console.log("🎬 Running FFmpeg with:", cmd);
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        console.log(stdout || stderr);
        resolve();
      });
    });

    if (!fs.existsSync(outputPath)) throw new Error("Output video not created.");

    console.log("✅ FFmpeg completed:", outputPath);
    const fileUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || "ffmpeg-video-api-ekkc.onrender.com"}/${path.basename(outputPath)}`;

    res.json({ video_url: fileUrl });

    // Optional cleanup (after 30s)
    setTimeout(() => {
      try {
        [audioPath, imagePath, outputPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
        console.log("🧹 Cleaned temp files for:", id);
      } catch (e) { console.error("Cleanup error:", e.message); }
    }, 30000);

  } catch (err) {
    console.error("💥 Merge error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Static serve for completed videos
app.use(express.static(TMP_DIR));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ FFmpeg Video API running on port ${PORT}`);
});
