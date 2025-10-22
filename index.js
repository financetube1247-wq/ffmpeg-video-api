app.post("/api/merge", async (req, res) => {
  try {
    console.log("📩 Received merge request");
    const { audio, image } = req.body;
    if (!audio || !image) {
      return res.status(400).json({ error: "Missing audio or image base64" });
    }

    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const id = uuidv4();

    // Detect real image format by magic bytes
    const imgBuf = Buffer.from(image, "base64");
    let ext = ".jpg";
    if (imgBuf[0] === 0x89 && imgBuf[1] === 0x50) ext = ".png"; // PNG signature
    const imagePath = path.join(TMP_DIR, `${id}${ext}`);
    const audioPath = path.join(TMP_DIR, `${id}.mp3`);
    const outputPath = path.join(TMP_DIR, `${id}-output.mp4`);

    fs.writeFileSync(imagePath, imgBuf);
    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    console.log(`✅ Files written: ${imagePath}, ${audioPath}`);

    // FFmpeg: convert image to video, pad to 16:9, ensure safe encoding
    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" \
      -vf "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p" \
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

    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg output not created");

    console.log("✅ FFmpeg finished successfully");
    const fileUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || "ffmpeg-video-api-ekkc.onrender.com"}/${path.basename(outputPath)}`;

    res.json({ video_url: fileUrl });

    setTimeout(() => {
      try {
        [imagePath, audioPath, outputPath].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
        console.log("🧹 Cleaned temp files for", id);
      } catch (e) { console.error("Cleanup error:", e.message); }
    }, 45000);
  } catch (err) {
    console.error("💥 Merge error:", err);
    res.status(500).json({ error: err.message });
  }
});
