import express from "express";
import cors from "cors";
import fs from "fs";
import { execSync } from "child_process";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" })); // allow big base64 payloads

app.get("/", (req, res) => {
  res.send("✅ FFmpeg Video API is live. Use POST /api/merge");
});

app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image, filename } = req.body;
    if (!audio || !image)
      return res.status(400).json({ error: "Missing audio or image data" });

    const audioPath = "/tmp/audio.mp3";
    const imagePath = "/tmp/image.jpg";
    const videoPath = `/tmp/${filename || "output"}.mp4`;

    // write base64 to temp files
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));

    // build video
    execSync(
      `ffmpeg -y -loop 1 -i ${imagePath} -i ${audioPath} \
       -c:v libx264 -tune stillimage -c:a aac -b:a 192k \
       -shortest -pix_fmt yuv420p ${videoPath}`,
      { stdio: "inherit" }
    );

    const videoBuffer = fs.readFileSync(videoPath);
    res.status(200).json({ videoBase64: videoBuffer.toString("base64") });
  } catch (err) {
    console.error("❌ FFmpeg error:", err.message);
    res.status(500).json({ error: `ffmpeg failed: ${err.message}` });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🎬 FFmpeg Video API running on ${PORT}`));
