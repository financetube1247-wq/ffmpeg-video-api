import express from "express";
import bodyParser from "body-parser";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const app = express();
app.use(bodyParser.json({ limit: "200mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image, filename } = req.body;
    if (!audio || !image) return res.status(400).json({ error: "Missing inputs" });

    const audioPath = __dirname + "/audio.mp3";
    const imagePath = __dirname + "/image.png";
    const outputPath = __dirname + "/" + (filename || "output.mp4");

    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));

    ffmpeg()
      .input(imagePath)
      .loop(5)
      .input(audioPath)
      .outputOptions("-c:v libx264", "-tune stillimage", "-c:a aac", "-b:a 192k", "-shortest")
      .save(outputPath)
      .on("end", () => {
        const videoBase64 = fs.readFileSync(outputPath).toString("base64");
        res.json({ videoBase64 });
        [audioPath, imagePath, outputPath].forEach(f => fs.unlinkSync(f));
      })
      .on("error", err => res.status(500).json({ error: err.message }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("✅ FFmpeg API running!"));
app.listen(10000, () => console.log("Server running on port 10000"));
