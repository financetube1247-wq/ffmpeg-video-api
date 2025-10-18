import express from "express";
import bodyParser from "body-parser";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const app = express();
app.use(bodyParser.json({ limit: "200mb" }));

// Point fluent-ffmpeg to internal ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image, filename } = req.body;
    if (!audio || !image)
      return res.status(400).json({ error: "Missing audio or image input" });

    const audioPath = __dirname + "/temp_audio.mp3";
    const imagePath = __dirname + "/temp_image.png";
    const outputPath = __dirname + "/" + (filename || "output.mp4");

    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));

    ffmpeg()
      .input(imagePath)
      .loop(10) // 10 seconds or until audio ends
      .input(audioPath)
      .audioCodec("aac")
      .videoCodec("libx264")
      .outputOptions(["-shortest", "-pix_fmt yuv420p"])
      .save(outputPath)
      .on("end", () => {
        const videoBase64 = fs.readFileSync(outputPath).toString("base64");
        res.json({ videoBase64 });
        [audioPath, imagePath, outputPath].forEach(f => fs.unlinkSync(f));
      })
      .on("error", err => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: err.message });
      });
  } catch (err) {
    console.error("Merge error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("✅ FinanceTubeAI FFmpeg API running!"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
