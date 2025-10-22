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

app.get("/", (_, res) => res.send("✅ FFmpeg Video API is live and healthy!"));

// ---------- MERGE ROUTE ----------
app.post("/api/merge", async (req, res) => {
  const start = Date.now();
  try {
    const { audio, image } = req.body;
    if (!audio || !image) return res.status(400).json({ error: "Missing audio or image base64" });

    const id = uuidv4();
    const imgBuf = Buffer.from(image, "base64");
    const ext = imgBuf[0] === 0x89 && imgBuf[1] === 0x50 ? ".png" : ".jpg";

    const imagePath = path.join(TMP_DIR, `${id}${ext}`);
    const audioPath = path.join(TMP_DIR, `${id}.mp3`);
    const outputPath = path.join(TMP_DIR, `${id}-output.mp4`);
    fs.writeFileSync(imagePath, imgBuf);
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));

    console.log(`🧩 Input ready → ${imagePath}`);

    // ✅ safer: pad instead of crop; no boxblur or invalid scaling
    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" \
      -vf "scale=1080:-1:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
      -c:v libx264 -preset ultrafast -tune stillimage -c:a aac -b:a 128k \
      -pix_fmt yuv420p -shortest -movflags +faststart "${outputPath}"`;

    console.log("🎬 FFmpeg running…");
    await new Promise((resv, rej) =>
      exec(cmd, { timeout: 180000 }, (err, out, errOut) => {
        if (err) return rej(errOut || err);
        console.log(out || errOut);
        resv();
      })
    );

    if (!fs.existsSync(outputPath)) throw new Error("No output created");
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || "ffmpeg-video-api-ekkc.onrender.com";
    const fileUrl = `https://${host}/${path.basename(outputPath)}`;
    res.json({ video_url: fileUrl });

    console.log(`✅ Done in ${(Date.now() - start) / 1000}s → ${fileUrl}`);

    setTimeout(() => {
      [imagePath, audioPath, outputPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    }, 45000);
  } catch (e) {
    console.error("💥 Merge error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(TMP_DIR));
app.listen(process.env.PORT || 10000, () => console.log("✅ FFmpeg Video API running"));
