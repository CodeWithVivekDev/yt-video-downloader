const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const contentDisposition = require('content-disposition');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve static ffmpeg path
const ffmpegPath = ffmpegInstaller.path;
console.log('--- YouTube Video Downloader Backend ---');
console.log('Using static ffmpeg from installer:', ffmpegPath);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure temp directory exists for active download jobs
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
  console.log('Created temporary directory at:', tempDir);
}

// In-memory Job Map: jobId -> job state object
const jobs = new Map();

// --- Smart YouTube Extraction Strategy ---
// Instead of blindly trying all browsers (which hammers YouTube and deepens 429 blocks),
// we use a layered strategy: try the best no-cookie approach first, then fall back smartly.

let lastWorkingStrategy = null; // Cache the strategy that last worked
let rateLimitCooldownUntil = 0; // Timestamp when we can retry after a 429

// Extraction strategies ordered by likelihood of success
// 'default' is tried first because it works reliably without sign-in on most machines.
// Other player clients (web_creator, mweb, ios) often trigger "Sign in" or format errors.
const EXTRACTION_STRATEGIES = [
  { name: 'default-no-cookies', playerClient: 'default', browser: null },
  { name: 'web_creator-no-cookies', playerClient: 'web_creator', browser: null },
  { name: 'mweb-no-cookies', playerClient: 'mweb', browser: null },
  { name: 'default-chrome', playerClient: 'default', browser: 'chrome' },
  { name: 'default-edge', playerClient: 'default', browser: 'edge' },
];

// Helper to spawn yt-dlp for info extraction with a specific strategy
function spawnYtdlpInfo(videoUrl, strategy) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      '-j',
      '--no-playlist',
      '--force-ipv4',
      '--no-check-certificates',
      '--prefer-insecure',
      '--no-warnings',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/'
    ];

    // Add player client if not default
    if (strategy.playerClient && strategy.playerClient !== 'default') {
      args.push('--extractor-args', `youtube:player_client=${strategy.playerClient}`);
    }

    // Add browser cookies only if strategy calls for it
    if (strategy.browser) {
      args.push('--cookies-from-browser', strategy.browser);
    }

    args.push(videoUrl);

    console.log(`[Info Spawn] Strategy "${strategy.name}": python ${args.join(' ')}`);
    const child = spawn('python', args);

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdoutData, strategy });
      } else {
        reject({ code, stderr: stderrData, strategy });
      }
    });
  });
}

// Helper: Format duration from seconds
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Helper: Format view counts into readable text (K, M, B)
function formatViews(num) {
  if (num >= 1000000000) {
    return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B views';
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M views';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K views';
  }
  return num.toString() + ' views';
}

/**
 * API Endpoint: Fetch video metadata using smart yt-dlp strategy
 */
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  console.log(`[Metadata Request] Fetching info for: ${videoUrl}`);

  // Check if we're still in a rate limit cooldown period
  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const waitSec = Math.ceil((rateLimitCooldownUntil - now) / 1000);
    console.warn(`[Rate Limit] Still in cooldown. ${waitSec}s remaining.`);
    return res.status(429).json({
      error: `YouTube rate limited your IP. Please wait ${waitSec} seconds before trying again.`,
      retryAfter: waitSec
    });
  }

  // Build strategy list: try last working strategy first, then the rest
  let strategies = [...EXTRACTION_STRATEGIES];
  if (lastWorkingStrategy) {
    strategies = [
      lastWorkingStrategy,
      ...strategies.filter(s => s.name !== lastWorkingStrategy.name)
    ];
  }

  let successResult = null;
  let lastError = null;
  let hit429 = false;

  for (const strategy of strategies) {
    // If we already hit a 429, don't keep trying — it only makes it worse
    if (hit429) break;

    try {
      successResult = await spawnYtdlpInfo(videoUrl, strategy);
      lastWorkingStrategy = strategy;
      console.log(`[Metadata Success] Worked with strategy: "${strategy.name}"`);
      break;
    } catch (err) {
      const stderrStr = err.stderr || '';
      const errBrief = stderrStr.split('\n').find(l => l.includes('ERROR:') || l.includes('HTTP Error')) || stderrStr.split('\n')[0] || 'unknown error';
      console.warn(`[Metadata Fail] Strategy "${strategy.name}": ${errBrief.trim()}`);

      // If it's a 429 rate limit, stop immediately — more requests make it worse
      if (stderrStr.includes('HTTP Error 429') || stderrStr.includes('Too Many Requests')) {
        hit429 = true;
        rateLimitCooldownUntil = Date.now() + 60000; // 60 second cooldown
        console.warn('[Rate Limit] Got 429 — entering 60s cooldown. Stopping further attempts.');
      }

      // If browser cookie DB doesn't exist, skip silently (don't count as YouTube error)
      if (stderrStr.includes('could not find') || stderrStr.includes('Could not copy') || stderrStr.includes('Failed to decrypt')) {
        console.log(`[Skip] Browser "${strategy.browser}" cookies unavailable, skipping.`);
        continue;
      }

      lastError = err;
    }
  }

  if (!successResult) {
    let errMsg = 'Could not fetch video info. Please check the URL and try again.';
    if (hit429) {
      errMsg = 'YouTube has temporarily blocked requests from your IP (rate limit). Please wait about 1 minute and try again. Avoid clicking "Analyze" repeatedly — each click makes the wait longer.';
    } else if (lastError && lastError.stderr && lastError.stderr.includes('Sign in to confirm')) {
      errMsg = 'YouTube is temporarily blocking this request. Please wait a minute and try again. If this keeps happening, try a different video URL.';
    }
    console.error(`[Metadata Failed] ${errMsg}`);
    return res.status(hit429 ? 429 : 500).json({ error: errMsg });
  }

  try {
    const info = JSON.parse(successResult.stdout);
    
    // Extract available height resolutions (filters out audio-only formats)
    const heights = new Set();
    if (info.formats && Array.isArray(info.formats)) {
      info.formats.forEach(f => {
        if (f.height && f.vcodec !== 'none') {
          heights.add(f.height);
        }
      });
    }
    
    // Filter list into standard quality steps
    const availableResolutions = [];
    if (heights.has(1080) || heights.has(1440) || heights.has(2160)) availableResolutions.push('1080p');
    if (heights.has(720)) availableResolutions.push('720p');
    if (heights.has(480)) availableResolutions.push('480p');
    if (heights.has(360)) availableResolutions.push('360p');
    
    // Fallback in case set is empty but basic height is reported
    if (availableResolutions.length === 0 && info.height) {
      availableResolutions.push(`${info.height}p`);
    }
    
    // Collect thumbnails
    const thumbnailList = info.thumbnails || [];
    const bestThumbnail = info.thumbnail || (thumbnailList.length > 0 ? thumbnailList[thumbnailList.length - 1].url : '');

    const responseData = {
      id: info.id,
      title: info.title,
      uploader: info.uploader || info.channel || 'Unknown Channel',
      duration: info.duration ? formatDuration(info.duration) : '0:00',
      viewCount: info.view_count ? formatViews(info.view_count) : '0',
      thumbnail: bestThumbnail,
      availableResolutions,
      originalUrl: videoUrl
    };

    console.log(`[Metadata Result] Title: "${info.title}", Resolutions: [${availableResolutions.join(', ')}]`);
    res.json(responseData);
  } catch (e) {
    console.error('Failed to parse yt-dlp JSON output:', e);
    res.status(500).json({ error: 'Failed to process video details.' });
  }
});

/**
 * API Endpoint: Initiate background download job
 */
app.post('/api/download', (req, res) => {
  const { url, format, quality, title } = req.body;
  
  if (!url || !format || !quality) {
    return res.status(400).json({ error: 'Missing required download parameters' });
  }

  // Generate unique ID
  const jobId = Date.now().toString() + Math.random().toString(36).substring(2, 7);
  
  const job = {
    id: jobId,
    status: 'initializing',
    progress: 0,
    format,
    quality,
    title: title || 'Video Download',
    filePath: '',
    error: null,
    process: null
  };
  
  jobs.set(jobId, job);
  console.log(`[Job Queued] ID: ${jobId}, Format: ${format}, Quality: ${quality}, Title: "${job.title}"`);
  
  // Start job execution immediately in background
  runDownloadJob(jobId, url);
  
  res.json({ jobId });
});

/**
 * Core Downloader: Spawns yt-dlp process and monitors progress
 */
function runDownloadJob(jobId, url) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  const ext = job.format === 'video' ? 'mp4' : 'mp3';
  const outPathPattern = path.join(tempDir, `${jobId}.%(ext)s`);
  job.filePath = path.join(tempDir, `${jobId}.${ext}`);
  
  let args = [];
  const extraArgs = [
    '--force-ipv4',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    '--referer', 'https://www.youtube.com/'
  ];

  // Use the last strategy that worked during info fetch
  const dlStrategy = lastWorkingStrategy || EXTRACTION_STRATEGIES[0];
  if (dlStrategy.playerClient && dlStrategy.playerClient !== 'default') {
    extraArgs.push('--extractor-args', `youtube:player_client=${dlStrategy.playerClient}`);
  }
  if (dlStrategy.browser) {
    extraArgs.push('--cookies-from-browser', dlStrategy.browser);
  }
  
  if (job.format === 'video') {
    // Select formats: best video matching chosen resolution (prefer H.264 mp4) + best audio stream (prefer m4a)
    let formatSelector = 'bestvideo[ext=mp4][vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[height<=1080]';
    if (job.quality === '720p') {
      formatSelector = 'bestvideo[ext=mp4][vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[height<=720]';
    } else if (job.quality === '480p') {
      formatSelector = 'bestvideo[ext=mp4][vcodec^=avc1][height<=480]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[height<=480]';
    } else if (job.quality === '360p') {
      formatSelector = 'bestvideo[ext=mp4][vcodec^=avc1][height<=360]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=360]+bestaudio[ext=m4a]/best[height<=360]';
    }
    
    args = [
      '-m', 'yt_dlp',
      '--ffmpeg-location', ffmpegPath,
      ...extraArgs,
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '-o', outPathPattern,
      '--no-playlist',
      url
    ];
  } else {
    // Audio Mode: Download best audio and extract/convert to MP3
    const bitrate = job.quality === '320k' ? '320k' : job.quality === '192k' ? '192k' : '128k';
    args = [
      '-m', 'yt_dlp',
      '--ffmpeg-location', ffmpegPath,
      ...extraArgs,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', bitrate,
      '-o', outPathPattern,
      '--no-playlist',
      url
    ];
  }
  
  console.log(`[Job Process] Spawning: python ${args.join(' ')}`);
  const child = spawn('python', args);
  job.process = child;
  
  // yt-dlp download percentage regex — matches both "45.2%" and "100%"
  const progressRegex = /\[download\]\s+(\d+(?:\.\d+)?)%/;
  
  child.stdout.on('data', (data) => {
    const line = data.toString();
    
    // Parse progress percentage
    const match = line.match(progressRegex);
    if (match) {
      const percent = parseFloat(match[1]);
      // Map download phase to 0-90% of total task completion
      const scaledProgress = Math.min(Math.round(percent * 0.9), 90);
      job.progress = scaledProgress;
      job.status = 'downloading';
    } else if (line.includes('[Merger]')) {
      // 95% indicates merging video and audio streams
      job.status = 'merging';
      job.progress = 95;
    } else if (line.includes('[ExtractAudio]')) {
      // Audio conversion starting
      job.status = 'converting';
      job.progress = 93;
    } else if (line.includes('[ffmpeg]')) {
      // Active transcoding/converting
      job.status = 'converting';
      job.progress = 96;
    }
  });
  
  child.stderr.on('data', (data) => {
    const line = data.toString();
    console.error(`[Job ${jobId} stderr]:`, line.trim());

    // yt-dlp also writes progress to stderr — parse it here too
    const stderrMatch = line.match(progressRegex);
    if (stderrMatch) {
      const percent = parseFloat(stderrMatch[1]);
      const scaledProgress = Math.min(Math.round(percent * 0.9), 90);
      job.progress = scaledProgress;
      job.status = 'downloading';
    } else if (line.includes('[Merger]')) {
      job.status = 'merging';
      job.progress = 95;
    } else if (line.includes('[ExtractAudio]')) {
      job.status = 'converting';
      job.progress = 93;
    } else if (line.includes('[ffmpeg]')) {
      job.status = 'converting';
      job.progress = 96;
    }
  });
  
  child.on('close', (code) => {
    console.log(`[Job Close] ID: ${jobId}, Exit Code: ${code}`);
    
    const currentJob = jobs.get(jobId);
    if (!currentJob) return;
    
    if (code === 0) {
      // Double check if file exists at expected path
      if (fs.existsSync(currentJob.filePath)) {
        currentJob.status = 'completed';
        currentJob.progress = 100;
      } else {
        // yt-dlp may have saved with a different extension — search for the file
        const possibleExts = currentJob.format === 'video' 
          ? ['mp4', 'mkv', 'webm', 'mov', 'avi'] 
          : ['mp3', 'm4a', 'opus', 'ogg', 'webm', 'wav'];
        let found = false;
        for (const ext of possibleExts) {
          const altPath = path.join(tempDir, `${jobId}.${ext}`);
          if (fs.existsSync(altPath)) {
            console.log(`[Job ${jobId}] Found output at alternate extension: .${ext}`);
            currentJob.filePath = altPath;
            currentJob.status = 'completed';
            currentJob.progress = 100;
            found = true;
            break;
          }
        }
        if (!found) {
          currentJob.status = 'failed';
          currentJob.error = 'Download completed but the output file was not found on disk or merging failed.';
        }
      }
    } else {
      currentJob.status = 'failed';
      currentJob.error = `Download process failed (exit code ${code}). Try a different quality or format.`;
    }
    
    currentJob.process = null;
  });
}

/**
 * API Endpoint: Real-time SSE status reporter
 */
app.get('/api/download/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Set required Server-Sent Events headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  console.log(`[SSE Open] Progress listener connected for Job ID: ${jobId}`);

  const sendUpdate = () => {
    const currentJob = jobs.get(jobId);
    if (!currentJob) {
      res.write(`data: ${JSON.stringify({ status: 'failed', error: 'Job tracking state lost' })}\n\n`);
      res.end();
      clearInterval(intervalId);
      return;
    }

    res.write(`data: ${JSON.stringify({
      status: currentJob.status,
      progress: currentJob.progress,
      error: currentJob.error
    })}\n\n`);

    // Terminate connection if job terminates
    if (currentJob.status === 'completed' || currentJob.status === 'failed') {
      console.log(`[SSE Close] Job ${jobId} ended with status: ${currentJob.status}`);
      res.end();
      clearInterval(intervalId);
    }
  };

  // Immediate send
  sendUpdate();

  // Send update every 400ms
  const intervalId = setInterval(sendUpdate, 400);

  // Safely clear intervals on client close
  req.on('close', () => {
    clearInterval(intervalId);
  });
});

/**
 * API Endpoint: Serve file and auto-delete
 */
app.get('/api/download/file/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job || job.status !== 'completed') {
    return res.status(404).send('File is not ready or download job was not found.');
  }

  const filePath = job.filePath;
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File was missing from the server storage.');
  }

  // Sanitize title for browser download headers
  const safeTitle = job.title.replace(/[\\/:*?"<>|]/g, '');
  // Use the actual file extension (may differ from requested format due to fallback)
  const ext = path.extname(filePath).replace('.', '') || (job.format === 'video' ? 'mp4' : 'mp3');
  const downloadFileName = `${safeTitle}.${ext}`;

  console.log(`[Serving File] ID: ${jobId}, File: "${downloadFileName}"`);

  res.setHeader('Content-Disposition', contentDisposition(downloadFileName));
  
  // Send file to browser
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error(`[Serve Error] Failed to stream file to user:`, err);
    }

    // Proactive Cleanup: immediately delete temp file from server storage
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) {
        console.error(`[Cleanup Error] Failed to remove temp file: ${filePath}`, unlinkErr);
      } else {
        console.log(`[Cleanup Success] Deleted temp file: ${filePath}`);
      }
    });

    // Delete job mapping
    jobs.delete(jobId);
  });
});

/**
 * API Endpoint: CORS-bypassing proxy for YouTube thumbnails
 */
app.get('/api/thumbnail', async (req, res) => {
  const imageUrl = req.query.url;
  const title = req.query.title || 'thumbnail';
  
  if (!imageUrl) {
    return res.status(400).send('Thumbnail image URL is required');
  }

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch thumbnail image from YouTube');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '');
    res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}.jpg`));
    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.send(buffer);
  } catch (error) {
    console.error('Error proxying thumbnail:', error);
    res.status(500).send('Error downloading thumbnail');
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running locally at http://localhost:${PORT}`);
});
