/* ===================== RENDER API UPDATE - ADD CAPTION SUPPORT ===================== */

// ✅ REPLACE your callRender_() function with this enhanced version

function callRender_(imageBase64, audioBase64, captionText) {
  const requestId = Log.requestId();
  
  if (typeof imageBase64 !== "string" || typeof audioBase64 !== "string") {
    throw new Error(`[${requestId}] Invalid input types: image=${typeof imageBase64}, audio=${typeof audioBase64}`);
  }
  
  if (imageBase64.trim() === "" || audioBase64.trim() === "") {
    throw new Error(`[${requestId}] Empty base64 strings provided`);
  }
  
  if (imageBase64.trim().startsWith("{") || audioBase64.trim().startsWith("{")) {
    throw new Error(`[${requestId}] Received JSON object instead of base64 string`);
  }
  
  const imgKB = Math.round((imageBase64.length * 0.75) / 1024);
  const audKB = Math.round((audioBase64.length * 0.75) / 1024);
  
  // ✅ NEW: Sanitize caption text for safe transmission
  const safeCaption = captionText 
    ? captionText.trim().substring(0, 150) // Limit to 150 chars
    : null;
  
  Log.info(`[${requestId}] Calling Render API`, { 
    url: CFG.RENDER_URL,
    imageKB: imgKB,
    audioKB: audKB,
    caption: safeCaption 
  });
  
  // ✅ NEW: Include caption in payload
  const payload = { 
    image: imageBase64, 
    audio: audioBase64
  };
  
  if (safeCaption) {
    payload.caption = safeCaption;
  }
  
  const res = UrlFetchApp.fetch(CFG.RENDER_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  
  const code = res.getResponseCode();
  const text = res.getContentText() || "";
  
  Log.info(`[${requestId}] Render API response: ${code}`, { 
    preview: text.substring(0, 300) 
  });
  
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`[${requestId}] Render returned non-JSON (${code}): ${text.substring(0, 300)}`);
  }
  
  if (code !== 200) {
    const errMsg = json.error || json.message || text;
    throw new Error(`[${requestId}] Render API error (${code}): ${errMsg}`);
  }
  
  if (json.status === "processing" && json.check_url) {
    Log.info(`[${requestId}] Video queued for processing`, { 
      videoId: json.video_id,
      checkUrl: json.check_url 
    });
    
    return pollRenderStatus_(json.check_url, requestId);
  }
  
  if (json.video_url) {
    Log.info(`[${requestId}] Video URL received immediately`, { url: json.video_url });
    return downloadVideo_(json.video_url, requestId);
  }
  
  throw new Error(`[${requestId}] Unexpected Render response (200): ${text.substring(0, 500)}`);
}

// ✅ UPDATE ensureVideo_() to pass caption

function ensureVideo_(safeName, thumbFile, voiceFile, captionText) {
  const existing = findFileInFolderByPrefix_(
    CFG.VIDEO_FOLDER_ID,
    `${safeName}_short`,
    [".mp4"]
  );
  
  if (existing) {
    Log.info("Video file already exists, reusing");
    return existing;
  }
  
  Log.info("Rendering new video with caption");
  
  const imageBase64 = Utilities.base64Encode(thumbFile.getBlob().getBytes());
  const audioBase64 = Utilities.base64Encode(voiceFile.getBlob().getBytes());
  
  if (!imageBase64 || imageBase64.length < 100) {
    throw new Error("Invalid image base64 encoding");
  }
  if (!audioBase64 || audioBase64.length < 100) {
    throw new Error("Invalid audio base64 encoding");
  }
  
  Log.info("Assets encoded to base64", {
    imageLength: imageBase64.length,
    audioLength: audioBase64.length,
    caption: captionText ? captionText.substring(0, 50) + "..." : "none"
  });
  
  // ✅ NEW: Pass caption to Render API
  const videoBlob = withRetry_(() => {
    return callRender_(imageBase64, audioBase64, captionText);
  }, "RenderAPI", 2);
  
  const sizeKB = Math.round(videoBlob.getBytes().length / 1024);
  
  const file = DriveApp.getFolderById(CFG.VIDEO_FOLDER_ID)
    .createFile(videoBlob.setName(`${safeName}_short.mp4`));
  
  Log.success("Video saved to Drive", {
    name: file.getName(),
    size: sizeKB + " KB"
  });
  
  return file;
}

// ✅ UPDATE processRow_() to pass caption to ensureVideo_()

function processRow_(sheet, row, C) {
  const topic = (sheet.getRange(row, C.topic + 1).getValue() || "").toString().trim();
  
  if (!topic) {
    Log.warn(`Row ${row}: Empty topic, skipping`);
    return false;
  }
  
  Log.info(`Processing row ${row}`, { topic });
  
  const currentStatus = (sheet.getRange(row, C.status + 1).getValue() || "").toString();
  const hasYouTubeUrl = (sheet.getRange(row, C.yt + 1).getValue() || "").toString().trim();
  
  if (currentStatus === "Completed" && hasYouTubeUrl) {
    Log.info(`Row ${row} already completed, skipping`);
    return false;
  }
  
  if (isDuplicateCompleted_(sheet, C, topic)) {
    setStatus_(sheet, row, C, "Duplicate Skipped");
    return false;
  }
  
  const safeName = safeName_(topic);
  
  try {
    setStatus_(sheet, row, C, "Generating Script");
    const script = ensureScript_(topic, sheet, row, C, safeName);
    
    setStatus_(sheet, row, C, "Generating Metadata");
    const meta = ensureMeta_(topic, sheet, row, C);
    
    setStatus_(sheet, row, C, "Generating Thumbnail");
    const thumbFile = ensureThumbnail_(topic, safeName, sheet, row, C);
    
    setStatus_(sheet, row, C, "Generating Voice");
    const voiceFile = ensureVoice_(script, safeName, sheet, row, C);
    
    // ✅ NEW: Extract caption from title or topic (first 100 chars)
    const captionText = meta?.title || topic;
    
    setStatus_(sheet, row, C, "Rendering Video");
    const videoFile = ensureVideo_(safeName, thumbFile, voiceFile, captionText);
    
    if (C.vid >= 0) {
      sheet.getRange(row, C.vid + 1).setValue(videoFile.getUrl());
    }
    setStatus_(sheet, row, C, "Video Rendered");
    
    setStatus_(sheet, row, C, "Uploading to YouTube");
    const ytId = uploadToYouTube_(videoFile, meta, thumbFile);
    
    if (C.yt >= 0) {
      sheet.getRange(row, C.yt + 1).setValue("https://youtu.be/" + ytId);
    }
    
    setStatus_(sheet, row, C, "Completed");
    Log.success(`Row ${row} completed successfully!`, { youtubeId: ytId });
    
    return true;
    
  } catch (e) {
    const errMsg = e.message.substring(0, 200);
    setStatus_(sheet, row, C, "Error: " + errMsg);
    Log.error(`Row ${row} failed`, { error: e.message, stack: e.stack });
    throw e;
  }
}
