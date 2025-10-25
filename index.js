// =====================================================
// FILE: index.js (FinanceTubeAI Render API v3.2.0)
// Purpose: Merge image + audio into vertical YouTube Shorts-ready MP4
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

// ─────────────── Middleware ───────────────
app.use(express.json({ limit: "100mb" }));
app.use(cors());

// ─────────────── Directories ───────────────
const TMP_DIR = path.join(process.cwd(), "temp");
const VIDEO_DIR = path.join(process.cwd(), "public", "videos");
[ TMP_DIR, VIDEO_DIR ].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d,{recursive:true}));

// ─────────────── Job Tracking ───────────────
const videoJobs = new Map();

// ─────────────── Routes ───────────────

// Health check
app.get("/", (req,res)=>res.json({status:"online"}));

// Merge API
app.post("/api/merge", async (req,res)=>{
  const { image, audio } = req.body;
  if (!image || !audio)
    return res.status(400).json({error:"Missing base64 image or audio"});

  const id = uuidv4();
  const imgPath = path.join(TMP_DIR, `${id}.jpg`);
  const audPath = path.join(TMP_DIR, `${id}.mp3`);
  const outPath = path.join(VIDEO_DIR, `${id}.mp4`);

  // Save inputs
  fs.writeFileSync(imgPath, Buffer.from(image,"base64"));
  fs.writeFileSync(audPath, Buffer.from(audio,"base64"));

  // Track job
  videoJobs.set(id,{status:"processing",createdAt:Date.now()});

  // Respond immediately
  res.json({
    status:"processing",
    video_id:id,
    check_url:`/videos/${id}.mp4`,
    status_url:`/api/status/${id}`
  });

  // Process in background
  processVideo(id,imgPath,audPath,outPath);
});

// Job status
app.get("/api/status/:id",(req,res)=>{
  const j=videoJobs.get(req.params.id);
  if(!j) return res.status(404).json({error:"not found"});
  res.json(j);
});

// ─────────────── Core Processing ───────────────
async function processVideo(id,imgPath,audPath,outPath){
  const started=Date.now();
  try{
    console.log(`🎬 Processing ${id}`);

    // Single FFmpeg step: vertical 9:16, still image + AAC audio, H.264
    const cmd = `
      ffmpeg -y -hide_banner -loglevel error \
      -loop 1 -i "${imgPath}" -i "${audPath}" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1:1,format=yuv420p" \
      -c:v libx264 -pix_fmt yuv420p -preset veryfast -tune stillimage \
      -c:a aac -b:a 192k -shortest -movflags +faststart "${outPath}"
    `;

    // ✅ Give FFmpeg up to 4 minutes to complete
    await execPromise(cmd, { timeout: 240000 }).catch(err => {
      throw new Error(`FFmpeg failed or timed out: ${err.message}`);
    });

    // ✅ Check file output
    const st = fs.statSync(outPath);
    console.log(`🎞️ File generated: ${Math.round(st.size/1024)} KB`); // log size

    if(!st.size || st.size<150000)
      throw new Error(`Output too small (${st.size} bytes)`);

    // ✅ Mark job complete
    videoJobs.set(id,{
      status:"complete",
      videoId:id,
      size:st.size,
      url:`/videos/${id}.mp4`,
      processingTime:Math.round((Date.now()-started)/1000)
    });

    console.log(`✅ ${id} ready (${Math.round(st.size/1024)} KB)`);

  }catch(e){
    console.error("❌",id,e.message);
    videoJobs.set(id,{status:"error",error:e.message});
  }finally{
    // ✅ Cleanup temp files
    [imgPath,audPath].forEach(f=>{
      if(fs.existsSync(f)){
        try{ fs.unlinkSync(f); }catch(err){ console.error("Cleanup:",err.message); }
      }
    });
  }
}

// ─────────────── Serve videos with correct headers ───────────────
app.use("/videos",express.static(VIDEO_DIR,{
  setHeaders:(res,filePath)=>{
    if(filePath.endsWith(".mp4")){
      const s=fs.statSync(filePath);
      res.set({
        "Content-Type":"video/mp4",
        "Content-Length":s.size,
        "Accept-Ranges":"bytes",
        "Cache-Control":"public,max-age=3600"
      });
    }
  }
}));

// ─────────────── Start Server ───────────────
app.listen(process.env.PORT||10000,"0.0.0.0",()=>{
  console.log("✅ FFmpeg API running (v3.2.0)");
});
