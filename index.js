import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import { execSync } from "child_process";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "100mb" }));

// Health check
app.get("/", (req, res) => {
  res.send("✅ FFmpeg Video API is live. Use POST /api/merge");
});

// Main merge endpoint
app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image, filename } = req.body;
    if (!audio || !image)
      return res.status(400).json({ error: "Missing audio or image data" });

    const audioPath = "/tmp/temp_audio.mp3";
    const imagePath = "/tmp/temp_image.jpg";
    const videoPath = `/tmp/${filename || "output"}.mp4`;

    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));

    execSync(
      `ffmpeg -loop 1 -i ${imagePath} -i ${audioPath} -c:v libx264 -c:a aac -b:a 192k -shortest -pix_fmt yuv420p -y ${videoPath}`
    );

    const videoBuffer = fs.readFileSync(videoPath);
    res.status(200).json({ videoBase64: videoBuffer.toString("base64") });
  } catch (err) {
    console.error("❌ FFmpeg merge error:", err.message);
    res.status(500).json({ error: `ffmpeg exited: ${err.message}` });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Video API running on port ${PORT}`);
});
