import express from "express";
import cors from "cors";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { v4 as uuidv4 } from "uuid";
import ffmpegPath from "ffmpeg-static"; // Use ffmpeg-static for reliability

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 10000;
const TMP_DIR = join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

app.get("/", (req, res) => {
  res.send("✅ FFmpeg Video API is running. Use POST /api/merge");
});

app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image, filename } = req.body;
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    const id = uuidv4();
    const audioPath = join(TMP_DIR, `${id}.mp3`);
    const imagePath = join(TMP_DIR, `${id}.jpg`);
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

    console.log("🎬 Running FFmpeg with:", ffmpegArgs.join(" "));

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs); // Use ffmpeg-static path
    let stderrData = "";

    ffmpeg.stderr.on("data", d => (stderrData += d.toString()));

    ffmpeg.on("close", code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        const videoBase64 = fs.readFileSync(outputPath).toString("base64");
        res.json({ success: true, videoBase64 });
      } else {
        console.error("❌ FFmpeg merge failed:", stderrData);
        res.status(500).json({ error: "FFmpeg merge failed", log: stderrData });
      }

      [audioPath, imagePath, outputPath].forEach(p => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
    });

  } catch (err) {
    console.error("❌ API Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ FFmpeg Video API running on port ${PORT}`);
});
