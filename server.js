const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const contentDisposition = require('content-disposition');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Resolve static ffmpeg path
const ffmpegPath = ffmpegInstaller.path;
console.log('--- YouTube Video Downloader Backend ---');
console.log('Using static ffmpeg from installer:', ffmpegPath);

// Check if the PO Token provider plugin is available
const { execSync } = require('child_process');
try {
  execSync('python -c "import bgutil_ytdlp_pot_provider"', { stdio: 'ignore' });
  console.log('PO Token plugin: bgutil-ytdlp-pot-provider DETECTED (auto-bypass enabled)');
} catch (_) {
  console.warn('PO Token plugin: NOT FOUND — YouTube may block datacenter IPs. Install bgutil-ytdlp-pot-provider.');
}

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
const infoCache = new Map();
const clientInfoAttempts = new Map();

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RATE_LIMIT_COOLDOWN_MS = envNumber('YOUTUBE_RATE_LIMIT_COOLDOWN_MS', 5 * 60 * 1000);
const INFO_CACHE_TTL_MS = envNumber('INFO_CACHE_TTL_MS', 10 * 60 * 1000);
const CLIENT_INFO_WINDOW_MS = envNumber('CLIENT_INFO_WINDOW_MS', 60 * 1000);
const CLIENT_INFO_MAX_REQUESTS = envNumber('CLIENT_INFO_MAX_REQUESTS', 3);
const INFO_REQUEST_MIN_GAP_MS = envNumber('INFO_REQUEST_MIN_GAP_MS', 12 * 1000);
const YTDLP_PROXY_URL = process.env.YTDLP_PROXY_URL || process.env.QUOTAGUARDSTATIC_URL || '';
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || '';

function normalizeYouTubeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  try {
    const trimmed = rawUrl.trim();
    const urlWithProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(urlWithProtocol);
    const host = parsed.hostname.toLowerCase();
    const isYouTubeHost = host === 'youtu.be' ||
      host.endsWith('.youtu.be') ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com');

    if (!['http:', 'https:'].includes(parsed.protocol) || !isYouTubeHost) {
      return null;
    }

    parsed.hash = '';
    return parsed.toString();
  } catch (_err) {
    return null;
  }
}

function getVideoCacheKey(videoUrl) {
  try {
    const parsed = new URL(videoUrl);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      return pathParts[0] || videoUrl;
    }

    const directId = parsed.searchParams.get('v');
    if (directId) return directId;

    if (['shorts', 'embed', 'live'].includes(pathParts[0]) && pathParts[1]) {
      return pathParts[1];
    }
  } catch (_err) {
    // Fall through to full URL cache key.
  }

  return videoUrl;
}

function getCachedInfo(cacheKey) {
  const cached = infoCache.get(cacheKey);
  if (!cached) return null;

  if (Date.now() > cached.expiresAt) {
    infoCache.delete(cacheKey);
    return null;
  }

  return cached.data;
}

function setCachedInfo(cacheKey, data) {
  infoCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + INFO_CACHE_TTL_MS
  });

  if (infoCache.size > 100) {
    infoCache.delete(infoCache.keys().next().value);
  }
}

function getClientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getClientThrottleWaitSeconds(clientKey) {
  const now = Date.now();
  const cutoff = now - CLIENT_INFO_WINDOW_MS;
  const attempts = (clientInfoAttempts.get(clientKey) || []).filter(ts => ts > cutoff);
  const lastAttempt = attempts[attempts.length - 1] || 0;
  const minGapWait = lastAttempt + INFO_REQUEST_MIN_GAP_MS - now;

  if (minGapWait > 0) {
    clientInfoAttempts.set(clientKey, attempts);
    return Math.ceil(minGapWait / 1000);
  }

  if (attempts.length >= CLIENT_INFO_MAX_REQUESTS) {
    clientInfoAttempts.set(clientKey, attempts);
    return Math.ceil((attempts[0] + CLIENT_INFO_WINDOW_MS - now) / 1000);
  }

  attempts.push(now);
  clientInfoAttempts.set(clientKey, attempts);
  return 0;
}

function setRetryHeaders(res, waitSec) {
  res.setHeader('Retry-After', String(Math.max(1, waitSec)));
  res.setHeader('Cache-Control', 'no-store');
}

function isYouTubeRateLimit(stderr) {
  return /HTTP Error 429|Too Many Requests|Sign in to confirm/i.test(stderr || '');
}

function addYtdlpNetworkOptions(args) {
  if (YTDLP_PROXY_URL) {
    args.push('--proxy', YTDLP_PROXY_URL);
  }

  if (YTDLP_COOKIES_FILE) {
    args.push('--cookies', YTDLP_COOKIES_FILE);
  }
}

// Build the extractor-args string for a given player client.
// PO tokens are handled automatically by the bgutil-ytdlp-pot-provider plugin
// if it is installed — no manual token injection needed.
function buildExtractorArgs(playerClient) {
  return `youtube:player_client=${playerClient}`;
}

function safeYtdlpArgs(args) {
  const valueToMask = new Set(['--proxy', '--cookies']);
  return args.map((arg, index) => valueToMask.has(args[index - 1]) ? '[configured]' : arg);
}

// Extraction strategies ordered by likelihood of success on SERVER/datacenter IPs.
// web_creator and mweb are currently the most reliable for datacenter IPs (2026).
// Older clients like tv_embedded and android_vr are now mostly patched by YouTube.
const EXTRACTION_STRATEGIES = [
  { name: 'web_creator', playerClient: 'web_creator', browser: null },
  { name: 'mweb', playerClient: 'mweb', browser: null },
  { name: 'ios', playerClient: 'ios', browser: null },
  { name: 'tv_embedded', playerClient: 'tv_embedded', browser: null },
  { name: 'android_vr', playerClient: 'android_vr', browser: null },
  { name: 'android', playerClient: 'android', browser: null },
  { name: 'tv', playerClient: 'tv', browser: null },
  { name: 'default', playerClient: 'default', browser: null },
];

// Helper to spawn yt-dlp for info extraction with a specific strategy
function spawnYtdlpInfo(videoUrl, strategy) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      '-j',
      '--no-playlist',
      '--force-ipv4',
      '--user-agent', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--referer', 'https://www.youtube.com/'
    ];

    // Add player client with PO token if available
    if (strategy.playerClient && strategy.playerClient !== 'default') {
      args.push('--extractor-args', buildExtractorArgs(strategy.playerClient));
    } else {
      args.push('--extractor-args', buildExtractorArgs('default,web_creator'));
    }

    // Add browser cookies only if strategy calls for it
    if (strategy.browser) {
      args.push('--cookies-from-browser', strategy.browser);
    }

    addYtdlpNetworkOptions(args);
    args.push(videoUrl);

    console.log(`[Info Spawn] Strategy "${strategy.name}": python ${safeYtdlpArgs(args).join(' ')}`);
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
      // yt-dlp may exit with code 1 due to non-fatal warnings (e.g., missing JS runtime)
      // but still produce valid JSON on stdout. Resolve if we have usable output.
      const hasJsonOutput = stdoutData.trim().startsWith('{');
      const hasFatalError = stderrData.includes('ERROR:') ||
                            stderrData.includes('HTTP Error') ||
                            stderrData.includes('Sign in to confirm') ||
                            stderrData.includes('This video is not available');

      if (hasJsonOutput && !hasFatalError) {
        resolve({ stdout: stdoutData, strategy });
      } else if (code === 0) {
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
  const requestedUrl = req.query.url;
  if (!requestedUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const videoUrl = normalizeYouTubeUrl(requestedUrl);
  if (!videoUrl) {
    return res.status(400).json({ error: 'Please provide a valid YouTube video URL.' });
  }

  console.log(`[Metadata Request] Fetching info for: ${videoUrl}`);
  const cacheKey = getVideoCacheKey(videoUrl);
  const cachedInfo = getCachedInfo(cacheKey);
  if (cachedInfo) {
    console.log(`[Metadata Cache] Served cached info for: ${cacheKey}`);
    return res.json(cachedInfo);
  }

  // Check if we're still in a rate limit cooldown period
  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const waitSec = Math.ceil((rateLimitCooldownUntil - now) / 1000);
    console.warn(`[Rate Limit] Still in cooldown. ${waitSec}s remaining.`);
    setRetryHeaders(res, waitSec);
    return res.status(429).json({
      error: `YouTube rate limited your IP. Please wait ${waitSec} seconds before trying again.`,
      retryAfter: waitSec
    });
  }

  const clientKey = getClientKey(req);
  const clientWaitSec = getClientThrottleWaitSeconds(clientKey);
  if (clientWaitSec > 0) {
    console.warn(`[Client Throttle] ${clientKey} must wait ${clientWaitSec}s before another metadata request.`);
    setRetryHeaders(res, clientWaitSec);
    return res.status(429).json({
      error: `Please wait ${clientWaitSec} seconds before analyzing another video.`,
      retryAfter: clientWaitSec
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
      if (isYouTubeRateLimit(stderrStr)) {
        hit429 = true;
        lastError = err;
        rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        const cooldownSec = Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000);
        console.warn(`[Rate Limit] YouTube blocked the request - entering ${cooldownSec}s cooldown. Stopping further attempts.`);
        break;
      }

      // If browser cookie DB doesn't exist, skip silently (don't count as YouTube error)
      if (stderrStr.includes('could not find') || stderrStr.includes('Could not copy') || stderrStr.includes('Failed to decrypt')) {
        console.log(`[Skip] Browser "${strategy.browser}" cookies unavailable, skipping.`);
        continue;
      }

      // Small delay between retries to avoid hammering YouTube
      await new Promise(resolve => setTimeout(resolve, 1500));
      lastError = err;
    }
  }

  if (!successResult) {
    let errMsg = 'Could not fetch video info. Please check the URL and try again.';
    if (hit429) {
      errMsg = 'YouTube has temporarily blocked requests from this server IP. Please wait before trying again. Avoid clicking "Analyze" repeatedly - each click can make the wait longer.';
    } else if (lastError && lastError.stderr && lastError.stderr.includes('Sign in to confirm')) {
      errMsg = 'YouTube is temporarily blocking this request. Please wait a minute and try again. If this keeps happening, try a different video URL.';
    }
    console.error(`[Metadata Failed] ${errMsg}`);
    if (hit429) {
      const waitSec = Math.max(1, Math.ceil((rateLimitCooldownUntil - Date.now()) / 1000));
      setRetryHeaders(res, waitSec);
      return res.status(429).json({ error: errMsg, retryAfter: waitSec });
    }

    return res.status(500).json({ error: errMsg });
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
    setCachedInfo(cacheKey, responseData);
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

  const videoUrl = normalizeYouTubeUrl(url);
  if (!videoUrl) {
    return res.status(400).json({ error: 'Please provide a valid YouTube video URL.' });
  }

  const allowedVideoQualities = new Set(['1080p', '720p', '480p', '360p']);
  const allowedAudioQualities = new Set(['320k', '192k', '128k']);
  const validFormat = format === 'video' || format === 'audio';
  const validQuality = format === 'video'
    ? allowedVideoQualities.has(quality)
    : allowedAudioQualities.has(quality);

  if (!validFormat || !validQuality) {
    return res.status(400).json({ error: 'Invalid download format or quality.' });
  }

  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const waitSec = Math.ceil((rateLimitCooldownUntil - now) / 1000);
    setRetryHeaders(res, waitSec);
    return res.status(429).json({
      error: `YouTube rate limited your IP. Please wait ${waitSec} seconds before trying again.`,
      retryAfter: waitSec
    });
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
  runDownloadJob(jobId, videoUrl);
  
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
    '--user-agent', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--referer', 'https://www.youtube.com/'
  ];

  // Use the last strategy that worked during info fetch
  const dlStrategy = lastWorkingStrategy || EXTRACTION_STRATEGIES[0];
  if (dlStrategy.playerClient && dlStrategy.playerClient !== 'default') {
    extraArgs.push('--extractor-args', buildExtractorArgs(dlStrategy.playerClient));
  }
  if (dlStrategy.browser) {
    extraArgs.push('--cookies-from-browser', dlStrategy.browser);
  }
  addYtdlpNetworkOptions(extraArgs);
  
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
  
  console.log(`[Job Process] Spawning: python ${safeYtdlpArgs(args).join(' ')}`);
  const child = spawn('python', args);
  job.process = child;
  let jobStderr = '';
  
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
    jobStderr += line;
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
  
  // Safety timeout: kill stuck jobs after 10 minutes
  const jobTimeout = setTimeout(() => {
    const timeoutJob = jobs.get(jobId);
    if (timeoutJob && timeoutJob.status !== 'completed' && timeoutJob.status !== 'failed') {
      console.warn(`[Job Timeout] Job ${jobId} timed out after 10 minutes. Killing process.`);
      if (timeoutJob.process) timeoutJob.process.kill();
      timeoutJob.status = 'failed';
      timeoutJob.error = 'Download timed out after 10 minutes. Please try again.';
    }
  }, 10 * 60 * 1000);

  child.on('close', (code) => {
    clearTimeout(jobTimeout);
    console.log(`[Job Close] ID: ${jobId}, Exit Code: ${code}`);
    
    const currentJob = jobs.get(jobId);
    if (!currentJob) return;

    // Check if file exists regardless of exit code
    // yt-dlp may exit with code 1 on non-fatal warnings but still produce a valid file
    const checkFileExists = () => {
      if (fs.existsSync(currentJob.filePath)) {
        currentJob.status = 'completed';
        currentJob.progress = 100;
        return true;
      }
      // Search for alternate extensions
      const possibleExts = currentJob.format === 'video'
        ? ['mp4', 'mkv', 'webm', 'mov', 'avi']
        : ['mp3', 'm4a', 'opus', 'ogg', 'webm', 'wav'];
      for (const ext of possibleExts) {
        const altPath = path.join(tempDir, `${jobId}.${ext}`);
        if (fs.existsSync(altPath)) {
          console.log(`[Job ${jobId}] Found output at alternate extension: .${ext}`);
          currentJob.filePath = altPath;
          currentJob.status = 'completed';
          currentJob.progress = 100;
          return true;
        }
      }
      return false;
    };

    if (code === 0) {
      if (!checkFileExists()) {
        currentJob.status = 'failed';
        currentJob.error = 'Download completed but the output file was not found on disk or merging failed.';
      }
    } else {
      // Non-zero exit: still check if the file was created (warnings can cause non-zero exit)
      if (!checkFileExists()) {
        currentJob.status = 'failed';
        if (isYouTubeRateLimit(jobStderr)) {
          rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          currentJob.error = 'YouTube has temporarily blocked downloads from this server IP. Please wait before trying again.';
        } else {
          currentJob.error = `Download process failed (exit code ${code}). Try a different quality or format.`;
        }
      }
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

  // Validate that the URL points to a legitimate YouTube/Google image host
  try {
    const parsed = new URL(imageUrl);
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = [
      'i.ytimg.com', 'i9.ytimg.com', 'img.youtube.com',
      'yt3.ggpht.com', 'yt3.googleusercontent.com',
      'lh3.googleusercontent.com'
    ];
    if (!['http:', 'https:'].includes(parsed.protocol) || !allowedHosts.some(h => host === h || host.endsWith('.' + h))) {
      return res.status(403).send('Only YouTube thumbnail URLs are allowed');
    }
  } catch (_err) {
    return res.status(400).send('Invalid thumbnail URL');
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
