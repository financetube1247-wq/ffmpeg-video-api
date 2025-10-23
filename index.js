// =====================================================
// FILE 2: index.js
// =====================================================
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";

const execPromise = promisify(exec);
const app = express();

// Middleware
app.use(express.json({ limit: "100mb" }));
app.use(cors());

// Directories
const TMP_DIR = path.join(process.cwd(), "temp");
const VIDEO_DIR = path.join(process.cwd(), "public", "videos");

// Create directories
[TMP_DIR, VIDEO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
});

// Video status tracking
const videoJobs = new Map();

// Cleanup old videos (runs every 30 minutes)
setInterval(() => {
  const now = Date.now();
  const maxAge = 3600000; // 1 hour
  
  videoJobs.forEach((job, id) => {
    if (now - job.createdAt > maxAge) {
      const videoPath = path.join(VIDEO_DIR, `${id}.mp4`);
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          console.log(`🗑️ Cleaned up old video: ${id}`);
        } catch (e) {
          console.error(`Cleanup error: ${e.message}`);
        }
      }
      videoJobs.delete(id);
    }
  });
}, 1800000);

// =====================================================
// ROUTES
// =====================================================

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    version: "3.0.0",
    message: "✅ FFmpeg Video API is running",
    endpoints: {
      merge: "POST /api/merge",
      status: "GET /api/status/:videoId",
      video: "GET /videos/:videoId.mp4"
    }
  });
});

// Check FFmpeg
app.get("/api/health", async (req, res) => {
  try {
    const { stdout } = await execPromise("ffmpeg -version");
    const version = stdout.split('\n')[0];
    res.json({
      status: "healthy",
      ffmpeg: version,
      directories: {
        temp: fs.existsSync(TMP_DIR),
        videos: fs.existsSync(VIDEO_DIR)
      },
      activeJobs: videoJobs.size
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: error.message
    });
  }
});

// Get video status
app.get("/api/status/:videoId", (req, res) => {
  const job = videoJobs.get(req.params.videoId);
  
  if (!job) {
    return res.status(404).json({ 
      error: "Video not found",
      videoId: req.params.videoId
    });
  }
  
  res.json(job);
});

// Main video merge endpoint
app.post("/api/merge", async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { image, audio } = req.body;
    
    // Validate input
    if (!image || !audio) {
      return res.status(400).json({ 
        error: "Missing required fields: image and audio (base64)" 
      });
    }
    
    if (typeof image !== 'string' || typeof audio !== 'string') {
      return res.status(400).json({ 
        error: "image and audio must be base64 strings" 
      });
    }
    
    // Generate unique ID
    const videoId = uuidv4();
    
    // File paths
    const imgPath = path.join(TMP_DIR, `${videoId}.png`);
    const mp3Path = path.join(TMP_DIR, `${videoId}.mp3`);
    const wavPath = path.join(TMP_DIR, `${videoId}.wav`);
    const outPath = path.join(VIDEO_DIR, `${videoId}.mp4`);
    
    console.log(`📥 New request: ${videoId}`);
    
    // Decode and write files
    try {
      const imageBuffer = Buffer.from(image, "base64");
      const audioBuffer = Buffer.from(audio, "base64");
      
      fs.writeFileSync(imgPath, imageBuffer);
      fs.writeFileSync(mp3Path, audioBuffer);
      
      console.log(`✅ Files written: img=${Math.round(imageBuffer.length/1024)}KB, audio=${Math.round(audioBuffer.length/1024)}KB`);
    } catch (writeError) {
      return res.status(500).json({ 
        error: "Failed to write files",
        details: writeError.message 
      });
    }
    
    // Initialize job status
    videoJobs.set(videoId, {
      status: "processing",
      videoId: videoId,
      createdAt: Date.now(),
      progress: 0
    });
    
    // Send immediate response
    res.json({
      status: "processing",
      video_id: videoId,
      check_url: `/videos/${videoId}.mp4`,
      status_url: `/api/status/${videoId}`
    });
    
    // Process video in background
    processVideo(videoId, imgPath, mp3Path, wavPath, outPath, startTime);
    
  } catch (error) {
    console.error("💥 Request error:", error);
    res.status(500).json({ 
      error: "Internal server error",
      message: error.message 
    });
  }
});

// Background video processing
async function processVideo(videoId, imgPath, mp3Path, wavPath, outPath, startTime) {
  try {
    console.log(`🎬 Starting FFmpeg for ${videoId}`);
    
    // Update status
    videoJobs.set(videoId, {
      ...videoJobs.get(videoId),
      status: "processing",
      progress: 10
    });
    
    // Step 1: Convert MP3 to WAV
    const convertCmd = `ffmpeg -y -hide_banner -loglevel error -i "${mp3Path}" -ar 44100 -ac 2 "${wavPath}"`;
    
    try {
      await execPromise(convertCmd);
      console.log(`✅ Audio converted: ${videoId}`);
    } catch (convError) {
      throw new Error(`Audio conversion failed: ${convError.message}`);
    }
    
    // Verify WAV exists
    if (!fs.existsSync(wavPath)) {
      throw new Error("WAV file not created");
    }
    
    videoJobs.set(videoId, {
      ...videoJobs.get(videoId),
      progress: 40
    });
    
    // Step 2: Create video
    const mergeCmd = `ffmpeg -y -hide_banner -loglevel error \
      -loop 1 -i "${imgPath}" -i "${wavPath}" \
      -vf "scale=1080:-2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
      -c:v libx264 -preset ultrafast -tune stillimage \
      -c:a aac -b:a 128k -shortest -movflags +faststart \
      -t 60 \
      "${outPath}"`;
    
    try {
      await execPromise(mergeCmd, { timeout: 120000 }); // 2 minute timeout
      console.log(`✅ Video created: ${videoId}`);
    } catch (mergeError) {
      throw new Error(`Video merge failed: ${mergeError.message}`);
    }
    
    // Verify output file
    if (!fs.existsSync(outPath)) {
      throw new Error("Output video file not created");
    }
    
    const stats = fs.statSync(outPath);
    const sizeKB = Math.round(stats.size / 1024);
    
    if (stats.size === 0) {
      throw new Error("Output video is empty (0 bytes)");
    }
    
    if (stats.size < 100000) { // Less than 100KB is suspicious
      throw new Error(`Output video too small (${sizeKB} KB)`);
    }
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    // Update to complete
    videoJobs.set(videoId, {
      status: "complete",
      videoId: videoId,
      size: stats.size,
      sizeKB: sizeKB,
      url: `/videos/${videoId}.mp4`,
      processingTime: processingTime,
      completedAt: Date.now(),
      createdAt: videoJobs.get(videoId).createdAt
    });
    
    console.log(`✅ SUCCESS: ${videoId} (${sizeKB} KB in ${processingTime}s)`);
    
  } catch (error) {
    console.error(`❌ ERROR: ${videoId} - ${error.message}`);
    
    videoJobs.set(videoId, {
      status: "error",
      videoId: videoId,
      error: error.message,
      createdAt: videoJobs.get(videoId)?.createdAt || Date.now()
    });
    
  } finally {
    // Cleanup temp files
    [imgPath, mp3Path, wavPath].forEach(file => {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (e) {
          console.error(`Cleanup error for ${file}:`, e.message);
        }
      }
    });
  }
}

// Serve videos with proper headers
app.use("/videos", express.static(VIDEO_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      const stats = fs.statSync(filePath);
      res.set({
        'Content-Type': 'video/mp4',
        'Content-Length': stats.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });
    }
  }
}));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: "Endpoint not found",
    path: req.path
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("💥 Unhandled error:", err);
  res.status(500).json({ 
    error: "Internal server error",
    message: err.message 
  });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 FFmpeg Video API v3.0.0          ║
║   📡 Port: ${PORT}                       ║
║   ✅ Status: ONLINE                    ║
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

