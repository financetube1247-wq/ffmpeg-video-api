// =====================================================
// FILE: index.js (YouTube-ready v3.1.0)
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

app.use(express.json({ limit: "100mb" }));
app.use(cors());

const TMP_DIR = path.join(process.cwd(), "temp");
const VIDEO_DIR = path.join(process.cwd(), "public", "videos");
[ TMP_DIR, VIDEO_DIR ].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d,{recursive:true}));

const videoJobs = new Map();

/* ──────────────── ROUTES ──────────────── */
app.get("/", (req,res)=>res.json({status:"online"}));

app.post("/api/merge", async (req,res)=>{
  const { image, audio } = req.body;
  if (!image || !audio) return res.status(400).json({error:"Missing base64 image or audio"});
  const id = uuidv4();
  const imgPath = path.join(TMP_DIR, `${id}.jpg`);
  const audPath = path.join(TMP_DIR, `${id}.mp3`);
  const outPath = path.join(VIDEO_DIR, `${id}.mp4`);

  fs.writeFileSync(imgPath, Buffer.from(image,"base64"));
  fs.writeFileSync(audPath, Buffer.from(audio,"base64"));
  videoJobs.set(id,{status:"processing",createdAt:Date.now()});

  res.json({ status:"processing", video_id:id, check_url:`/videos/${id}.mp4`, status_url:`/api/status/${id}` });
  processVideo(id,imgPath,audPath,outPath);
});

app.get("/api/status/:id",(req,res)=>{
  const j=videoJobs.get(req.params.id);
  if(!j)return res.status(404).json({error:"not found"});
  res.json(j);
});

async function processVideo(id,imgPath,audPath,outPath){
  const started=Date.now();
  try{
    console.log(`🎬 Processing ${id}`);

    // ✅ FIX: single FFmpeg step with H.264 + AAC + faststart + 9:16 scaling
    const cmd = `
      ffmpeg -y -hide_banner -loglevel error \
      -loop 1 -i "${imgPath}" -i "${audPath}" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1:1,format=yuv420p" \
      -c:v libx264 -pix_fmt yuv420p -preset veryfast -tune stillimage \
      -c:a aac -b:a 192k -shortest -movflags +faststart "${outPath}"
    `;

    await execPromise(cmd);
    const st=fs.statSync(outPath);
    if(!st.size || st.size<150000) throw new Error(`Output too small (${st.size} bytes)`);

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
    [imgPath,audPath].forEach(f=>fs.existsSync(f)&&fs.unlinkSync(f));
  }
}

/* ─────────────── Serve videos with correct headers ─────────────── */
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

app.listen(process.env.PORT||10000,"0.0.0.0",()=>console.log("✅ FFmpeg API running"));
