// FFmpeg Video API v2.6_StreamSave_Final (CommonJS)
const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json({ limit: "40mb" })); // tighter than 80mb

// folders
const ROOT = __dirname;
const TMP_DIR = path.join(ROOT, "tmp");
const PUB_DIR = path.join(ROOT, "public");
const VID_DIR = path.join(PUB_DIR, "videos");

[ TMP_DIR, PUB_DIR, VID_DIR ].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// static hosting for finished mp4
app.use(express.static(PUB_DIR));

app.get("/", (_req, res) => {
  res.status(200).send("✅ FFmpeg Video API v2.6_StreamSave_Final is live and healthy!");
});

function sh(cmd, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message)));
      resolve(stdout || stderr || "");
    });
  });
}

function extFromImage(buf) {
  // PNG magic: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  // JPG magic: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  return ".png"; // default
}

app.post("/api/merge", async (req, res) => {
  const started = new Date().toISOString();
  const id = uuidv4();
  console.log(`📩 [${started}] Received /api/merge request for ${id}`);

  try {
    const { audio, image } = req.body || {};
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    // write temp files
    const imgBuf = Buffer.from(image, "base64");
    const imgExt = extFromImage(imgBuf);
    const imgPath = path.join(TMP_DIR, `${id}${imgExt}`);
    const mp3Path = path.join(TMP_DIR, `${id}.mp3`);
    const wavPath = path.join(TMP_DIR, `${id}.wav`);
    const outPath = path.join(VID_DIR, `${id}.mp4`);

    fs.writeFileSync(imgPath, imgBuf);
    fs.writeFileSync(mp3Path, Buffer.from(audio, "base64"));
    console.log(`✅ Temp files written: ${path.basename(imgPath)}, ${path.basename(mp3Path)}`);

    // probe duration (optional)
    try {
      const probe = await sh(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mp3Path}"`, 15000);
      const dur = parseFloat((probe || "0").trim());
      if (!isNaN(dur) && dur > 0) console.log(`🎧 MP3 duration: ${dur.toFixed(2)}s`);
    } catch { /* ignore */ }

    console.log("🎧 Converting MP3 → WAV...");
    await sh(`ffmpeg -y -hide_banner -loglevel error -i "${mp3Path}" -ar 44100 -ac 2 "${wavPath}"`, 60000);

    console.log("🎬 Rendering vertical video...");
    // 1080x1920 letterbox, clean & fast
    const cmd = `ffmpeg -y -hide_banner -loglevel error -loop 1 -i "${imgPath}" -i "${wavPath}" ` +
      `-vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" ` +
      `-c:v libx264 -preset veryfast -tune stillimage -c:a aac -b:a 128k -shortest -movflags +faststart "${outPath}"`;
    await sh(cmd, 180000);

    if (!fs.existsSync(outPath)) throw new Error("Render failed: output mp4 not created.");

    const host = process.env.RENDER_EXTERNAL_HOSTNAME || req.get("host");
    const proto = host && host.includes("localhost") ? "http" : "https";
    const url = `${proto}://${host}/videos/${path.basename(outPath)}`;

    console.log(`✅ Render complete for ${id}`);
    // cleanup temp (keep mp4 in /public)
    setTimeout(() => {
      try {
        [imgPath, mp3Path, wavPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
      } catch {}
    }, 20000);

    return res.json({ video_url: url });
  } catch (e) {
    console.error("💥 Merge error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ FFmpeg API running on port ${PORT}`));
