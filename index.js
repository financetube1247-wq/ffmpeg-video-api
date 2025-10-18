import express from "express";
import fs from "fs";
import { exec } from "child_process";

const app = express();

// allow large base64 uploads
app.use(express.json({ limit: "50mb" }));

app.get("/", (_req, res) => {
  res.status(200).send("✅ FFmpeg Video API is running (base64 mode)");
});

app.post("/api/merge", async (req, res) => {
  try {
    const { audio, image, filename } = req.body || {};
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    const audioPath = "temp_audio.mp3";
    const imagePath = "temp_image.png";
    const outName = (filename || "output.mp4").replace(/[^\w.\- ]/g, "_");

    // write files from base64 → binary
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));

    // run ffmpeg (merge still image + audio)
    const cmd = [
      `ffmpeg -y`,
      `-loop 1 -framerate 2 -i ${imagePath}`,
      `-i ${audioPath}`,
      `-c:v libx264 -tune stillimage -pix_fmt yuv420p`,
      `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"`,
      `-c:a aac -b:a 192k`,
      `-shortest`,
      outName
    ].join(" ");

    exec(cmd, { timeout: 300000 }, (err, _stdout, stderr) => {
      if (err) {
        console.error("ffmpeg error:", stderr || err.message);
        return res.status(500).json({ error: "ffmpeg failed to merge audio & image" });
      }

      try {
        const videoBuffer = fs.readFileSync(outName);
        const b64 = videoBuffer.toString("base64");
        // cleanup
        fs.unlinkSync(audioPath);
        fs.unlinkSync(imagePath);
        fs.unlinkSync(outName);
        res.status(200).json({ videoBase64: b64 });
      } catch (readErr) {
        console.error("read error:", readErr.message);
        res.status(500).json({ error: "failed to read output" });
      }
    });
  } catch (e) {
    console.error("server error:", e.message);
    res.status(500).json({ error: "internal server error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🎥 Server running on port", PORT));
