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
    let info = null;

    if (hit429) {
      console.warn('[Metadata] yt-dlp hit 429. Attempting Invidious fallback...');
      try {
        const videoIdMatch = videoUrl.match(/(?:v=|youtu\.be\/)([^&]+)/);
        if (videoIdMatch && videoIdMatch[1]) {
          const invId = videoIdMatch[1];
          // Use fetch (Node.js 18+) to get fallback metadata from a public Invidious instance
          const invReq = await fetch(`https://inv.thepixora.com/api/v1/videos/${invId}`);
          if (invReq.ok) {
            const invData = await invReq.json();
            // Map Invidious formatStreams to yt-dlp format style for compatibility
            const mappedFormats = [];
            if (invData.formatStreams) {
              invData.formatStreams.forEach(fs => {
                mappedFormats.push({
                  url: fs.url,
                  vcodec: 'avc1',
                  acodec: 'mp4a',
                  height: parseInt(fs.resolution) || 0,
                  ext: 'mp4'
                });
              });
            }
            if (invData.adaptiveFormats) {
              invData.adaptiveFormats.forEach(af => {
                if (af.type && af.type.includes('audio')) {
                  mappedFormats.push({
                    url: af.url,
                    vcodec: 'none',
                    acodec: 'mp4a',
                    abr: parseInt(af.bitrate) || 128000,
                    ext: 'm4a'
                  });
                }
              });
            }
            info = {
              id: invData.videoId,
              title: invData.title,
              uploader: invData.author,
              duration: invData.lengthSeconds,
              view_count: invData.viewCount,
              thumbnail: invData.videoThumbnails && invData.videoThumbnails.length > 0 ? invData.videoThumbnails[0].url : '',
              formats: mappedFormats
            };
            console.log('[Metadata] Invidious fallback succeeded.');
            successResult = { stdout: JSON.stringify(info) };
          }
        }
      } catch (fallbackErr) {
        console.error('[Metadata] Invidious fallback failed:', fallbackErr);
      }
    }

    if (!successResult) {
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
      originalUrl: videoUrl,
      rawFormats: info.formats || []
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
 * API Endpoint: Direct Stream Proxy
 * Proxies the direct YouTube video/audio stream to the client browser.
 */
app.get('/api/stream', async (req, res) => {
  const { url, format, quality, title } = req.query;
  
  if (!url || !format || !quality) {
    return res.status(400).send('Missing required download parameters');
  }

  const videoUrl = normalizeYouTubeUrl(url);
  if (!videoUrl) {
    return res.status(400).send('Invalid YouTube URL');
  }

  // Find the video in our info cache to get the direct streaming URLs
  const cacheKey = getVideoCacheKey(videoUrl);
  const cachedInfo = getCachedInfo(cacheKey);
  
  if (!cachedInfo || !cachedInfo.rawFormats || cachedInfo.rawFormats.length === 0) {
    return res.status(400).send('Video metadata expired or not found. Please click Analyze Video again.');
  }

  // Select the best direct URL based on requested quality
  let streamUrl = null;
  let ext = format === 'video' ? 'mp4' : 'm4a';
  
  if (format === 'video') {
    // For video, we only support pre-merged formats (vcodec && acodec) to avoid ffmpeg
    const targetHeight = parseInt(quality) || 720;
    const suitableFormats = cachedInfo.rawFormats.filter(f => 
      f.vcodec !== 'none' && 
      f.acodec !== 'none' && 
      f.height <= targetHeight &&
      f.ext === 'mp4'
    ).sort((a, b) => b.height - a.height); // Highest quality first

    if (suitableFormats.length > 0) {
      streamUrl = suitableFormats[0].url;
    } else {
      // Fallback: Just get any pre-merged mp4
      const anyPreMerged = cachedInfo.rawFormats.find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4');
      if (anyPreMerged) streamUrl = anyPreMerged.url;
    }
  } else {
    // For audio, we want the highest quality audio-only stream (preferably m4a)
    const suitableFormats = cachedInfo.rawFormats.filter(f => 
      f.vcodec === 'none' && 
      f.acodec !== 'none' &&
      f.ext === 'm4a'
    ).sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (suitableFormats.length > 0) {
      streamUrl = suitableFormats[0].url;
    } else {
      // Fallback: any audio only
      const anyAudio = cachedInfo.rawFormats.find(f => f.vcodec === 'none' && f.acodec !== 'none');
      if (anyAudio) {
        streamUrl = anyAudio.url;
        ext = anyAudio.ext || 'm4a';
      }
    }
  }

  if (!streamUrl) {
    return res.status(404).send(`Could not find a direct stream for ${format} at ${quality}. Please try a different quality.`);
  }

  const safeTitle = (title || 'Video Download').replace(/[\\/:*?"<>|]/g, '');
  const downloadFileName = `${safeTitle}.${ext}`;

  console.log(`[Stream Proxy] Starting proxy stream for "${downloadFileName}"`);
  
  res.setHeader('Content-Disposition', contentDisposition(downloadFileName));
  
  try {
    const { Readable } = require('stream');
    const fetchRes = await fetch(streamUrl, { 
      headers: { 
        // Emulate a standard browser request
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.youtube.com/'
      } 
    });
    
    if (!fetchRes.ok) {
      console.error(`[Stream Error] Upstream returned ${fetchRes.status}: ${fetchRes.statusText}`);
      return res.status(502).send('Upstream streaming server returned an error: ' + fetchRes.statusText);
    }
    
    // Forward relevant headers to the client
    if (fetchRes.headers.get('content-length')) {
      res.setHeader('Content-Length', fetchRes.headers.get('content-length'));
    }
    if (fetchRes.headers.get('content-type')) {
      res.setHeader('Content-Type', fetchRes.headers.get('content-type'));
    }
    
    // Pipe the Web Stream from fetch into the Node.js Express Response
    Readable.fromWeb(fetchRes.body).pipe(res);
    
    req.on('close', () => {
      // Browser disconnected early
      console.log(`[Stream Proxy] Client disconnected from stream: "${downloadFileName}"`);
    });
  } catch (err) {
    console.error('[Stream Proxy Error]', err);
    if (!res.headersSent) {
      res.status(500).send('Error proxying media stream from upstream servers.');
    }
  }
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
