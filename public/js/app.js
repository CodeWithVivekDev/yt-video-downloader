/**
 * StreamVault Premium Client Application Logic
 * Powered by Antigravity paired with Express & yt-dlp
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- STATE SYSTEM ---
  const state = {
    currentSection: 'search-section',
    videoInfo: null,
    activeFormat: 'video', // 'video' | 'audio'
    selectedQuality: null,
    activeJobId: null,
    eventSource: null,
    infoRetryUntil: 0,
    infoRetryTimer: null
  };

  // --- DOM SELECTORS ---
  const sections = {
    search: document.getElementById('search-section'),
    config: document.getElementById('config-section'),
    progress: document.getElementById('progress-section'),
    success: document.getElementById('success-section')
  };

  // Search screen elements
  const inputUrl = document.getElementById('video-url-input');
  const btnPaste = document.getElementById('btn-paste');
  const btnClear = document.getElementById('btn-clear');
  const btnFetch = document.getElementById('btn-fetch');
  const btnFetchLabel = btnFetch.querySelector('span');
  const defaultFetchLabel = btnFetchLabel ? btnFetchLabel.textContent : 'Find Video';
  const infoLoader = document.getElementById('info-loader');

  // Config screen elements
  const btnConfigBack = document.getElementById('btn-config-back');
  const mediaThumbnail = document.getElementById('media-thumbnail');
  const mediaDuration = document.getElementById('media-duration');
  const mediaTitle = document.getElementById('media-title');
  const mediaUploader = document.getElementById('media-uploader');
  const mediaViews = document.getElementById('media-views');
  const tabVideo = document.getElementById('tab-video');
  const tabAudio = document.getElementById('tab-audio');
  const videoOptions = document.getElementById('video-options');
  const audioOptions = document.getElementById('audio-options');
  const videoResolutionsList = document.getElementById('video-resolutions-list');
  const btnStartDownload = document.getElementById('btn-start-download');

  // Progress screen elements
  const progressMediaTitle = document.getElementById('progress-media-title');
  const progressMediaFormat = document.getElementById('progress-media-format');
  const progressPercentText = document.getElementById('progress-percent-text');
  const progressStatusSlug = document.getElementById('progress-status-slug');
  const progressLinearBar = document.getElementById('progress-linear-bar');
  const progressRingIndicator = document.getElementById('progress-ring-indicator');
  const consoleLogs = document.getElementById('console-logs');
  const stageDownload = document.getElementById('stage-download');
  const stageProcess = document.getElementById('stage-process');
  const stageReady = document.getElementById('stage-ready');

  // Success screen elements
  const successMediaTitle = document.getElementById('success-media-title');
  const successMediaMeta = document.getElementById('success-media-meta');
  const btnDownloadFile = document.getElementById('btn-download-file');
  const btnDownloadAnother = document.getElementById('btn-download-another');


  // --- INITIALIZATION ---
  initTheme();
  setupEventListeners();

  // --- THEME ENGINE ---
  function initTheme() {
    let savedTheme = localStorage.getItem('streamvault_theme');
    if (!savedTheme) {
      savedTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      document.getElementById('theme-toggle').querySelector('.theme-text').textContent = 'Dark Mode';
    } else {
      document.body.classList.remove('light-mode');
      document.getElementById('theme-toggle').querySelector('.theme-text').textContent = 'Light Mode';
    }
  }

  // --- NAVIGATION SYSTEM ---
  function showSection(sectionId) {
    Object.keys(sections).forEach(key => {
      const section = sections[key];
      if (section.id === sectionId) {
        section.classList.remove('hidden');
        section.classList.add('active');
      } else {
        section.classList.add('hidden');
        section.classList.remove('active');
      }
    });
    state.currentSection = sectionId;
  }

  // --- TOAST ALERTS SYSTEM ---
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconClass = 'fa-circle-info';
    if (type === 'success') iconClass = 'fa-circle-check';
    if (type === 'warning') iconClass = 'fa-triangle-exclamation';
    if (type === 'danger') iconClass = 'fa-circle-xmark';

    toast.innerHTML = `
      <i class="fa-solid ${iconClass} toast-icon"></i>
      <div class="toast-message">${message}</div>
      <button class="toast-close"><i class="fa-solid fa-xmark"></i></button>
    `;

    container.appendChild(toast);

    // Close on button click
    toast.querySelector('.toast-close').addEventListener('click', () => {
      dismissToast(toast);
    });

    // Auto dismiss after 4s
    setTimeout(() => {
      dismissToast(toast);
    }, 4500);
  }

  function dismissToast(toast) {
    if (!toast.parentNode) return;
    toast.classList.add('removing');
    toast.addEventListener('transitionend', () => {
      toast.remove();
    });
  }

  function setFetchLabel(text) {
    if (btnFetchLabel) {
      btnFetchLabel.textContent = text;
    }
  }

  function startAnalyzeCooldown(seconds) {
    const waitMs = Math.max(1, Number(seconds) || 1) * 1000;
    state.infoRetryUntil = Date.now() + waitMs;
    if (state.infoRetryTimer) clearInterval(state.infoRetryTimer);

    const tick = () => {
      const remaining = Math.ceil((state.infoRetryUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(state.infoRetryTimer);
        state.infoRetryTimer = null;
        state.infoRetryUntil = 0;
        btnFetch.disabled = false;
        setFetchLabel(defaultFetchLabel);
        return;
      }

      btnFetch.disabled = true;
      setFetchLabel(`Wait ${remaining}s`);
    };

    tick();
    state.infoRetryTimer = setInterval(tick, 1000);
  }

  // --- EVENT LISTENERS SETUP ---
  function setupEventListeners() {
    // Input interaction
    inputUrl.addEventListener('input', () => {
      if (inputUrl.value.trim() !== '') {
        btnClear.classList.remove('hidden');
      } else {
        btnClear.classList.add('hidden');
      }
    });

    btnClear.addEventListener('click', () => {
      inputUrl.value = '';
      btnClear.classList.add('hidden');
      inputUrl.focus();
    });

    // Clipboard Paste helper
    btnPaste.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          inputUrl.value = text;
          btnClear.classList.remove('hidden');
          showToast('URL pasted from clipboard', 'success');
        }
      } catch (err) {
        showToast('Clipboard access denied. Please paste manually.', 'warning');
      }
    });

    // Enter key triggers search
    inputUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnFetch.click();
      }
    });

    // Analyze button trigger
    btnFetch.addEventListener('click', fetchVideoMetadata);

    // Config back navigation
    btnConfigBack.addEventListener('click', () => {
      showSection('search-section');
    });

    // Tabs for Video vs Audio format
    tabVideo.addEventListener('click', () => {
      toggleFormat('video');
    });

    tabAudio.addEventListener('click', () => {
      toggleFormat('audio');
    });

    // Start download trigger
    btnStartDownload.addEventListener('click', startDownloadJob);

    // Download another trigger (reset)
    btnDownloadAnother.addEventListener('click', () => {
      inputUrl.value = '';
      btnClear.classList.add('hidden');
      showSection('search-section');
    });


    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const isLight = document.body.classList.toggle('light-mode');
      localStorage.setItem('streamvault_theme', isLight ? 'light' : 'dark');
      document.getElementById('theme-toggle').querySelector('.theme-text').textContent = isLight ? 'Dark Mode' : 'Light Mode';
      showToast(`Switched to ${isLight ? 'Light' : 'Dark'} Mode`, 'success');
    });
  }

  // --- CONTROLLER: FETCH VIDEO DETAILS ---
  async function fetchVideoMetadata() {
    if (Date.now() < state.infoRetryUntil) {
      const remaining = Math.ceil((state.infoRetryUntil - Date.now()) / 1000);
      showToast(`Please wait ${remaining} seconds before trying again.`, 'warning');
      return;
    }

    const url = inputUrl.value.trim();
    if (!url) {
      showToast('Please enter a YouTube link first', 'warning');
      return;
    }

    // Basic YouTube format validation
    if (!url.includes('youtube.com/') && !url.includes('youtu.be/') && !url.includes('youtube-nocookie.com/')) {
      showToast('Please provide a valid YouTube video URL', 'danger');
      return;
    }

    // Enter Loading State
    btnFetch.disabled = true;
    setFetchLabel('Searching...');
    inputUrl.disabled = true;
    infoLoader.classList.remove('hidden');
    btnClear.classList.add('hidden');
    btnPaste.disabled = true;

    try {
      const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const retryAfter = Number(data.retryAfter) || Number(response.headers.get('Retry-After')) || 0;
        const error = new Error(data.error || 'Failed to extract video information');
        error.retryAfter = retryAfter;
        error.status = response.status;
        throw error;
      }

      state.videoInfo = data;
      renderConfigScreen(data);
      showSection('config-section');
    } catch (err) {
      console.error(err);
      if (err.retryAfter) {
        startAnalyzeCooldown(err.retryAfter);
      }
      showToast(err.message || 'Error fetching video data.', 'danger');
    } finally {
      // Exit Loading State
      inputUrl.disabled = false;
      infoLoader.classList.add('hidden');
      if (inputUrl.value.trim() !== '') btnClear.classList.remove('hidden');
      btnPaste.disabled = false;
      if (Date.now() >= state.infoRetryUntil) {
        btnFetch.disabled = false;
        setFetchLabel(defaultFetchLabel);
      }
    }
  }

  // --- RENDER CONFIG SECTION ---
  function renderConfigScreen(info) {
    // Media previews
    // Proxy thumbnail through backend to avoid CORS and hotlink issues
    mediaThumbnail.src = `/api/thumbnail?url=${encodeURIComponent(info.thumbnail)}&title=${encodeURIComponent(info.title)}`;
    mediaDuration.textContent = info.duration;
    mediaTitle.textContent = info.title;
    mediaUploader.innerHTML = `<i class="fa-solid fa-circle-check verification-icon"></i> ${info.uploader}`;
    mediaViews.innerHTML = `<i class="fa-regular fa-eye"></i> ${info.viewCount}`;

    // Resolutions List Rendering
    videoResolutionsList.innerHTML = '';
    const resolutions = info.availableResolutions || [];

    if (resolutions.length === 0) {
      // Fallback
      resolutions.push('720p', '360p');
    }

    resolutions.forEach((res, index) => {
      const button = document.createElement('button');
      button.className = `quality-card ${index === 0 ? 'active' : ''}`;
      button.dataset.quality = res;
      
      let badgeHtml = '';
      let cleanTitle = `${res} Video`;
      if (res === '1080p') {
        badgeHtml = '<span class="badge hq">Best Quality</span>';
        cleanTitle = 'Best Quality (1080p)';
      } else if (res === '720p') {
        badgeHtml = '<span class="badge">High Quality</span>';
        cleanTitle = 'High Quality (720p)';
      } else if (res === '480p') {
        cleanTitle = 'Medium Quality (480p)';
      } else if (res === '360p') {
        cleanTitle = 'Low Quality (360p)';
      }

      button.innerHTML = `
        <div class="quality-card-header">
          <span class="quality-title">${cleanTitle}</span>
          ${badgeHtml}
        </div>
        <div class="quality-meta">Great for viewing on any device</div>
      `;

      button.addEventListener('click', () => {
        document.querySelectorAll('#video-resolutions-list .quality-card').forEach(c => c.classList.remove('active'));
        button.classList.add('active');
        state.selectedQuality = res;
      });

      videoResolutionsList.appendChild(button);
    });

    // Default Quality Selections
    state.activeFormat = 'video';
    state.selectedQuality = resolutions[0];
    toggleFormat('video');
  }

  // Toggle format tab between Video (MP4) and Audio (MP3)
  function toggleFormat(format) {
    state.activeFormat = format;
    if (format === 'video') {
      tabVideo.classList.add('active');
      tabAudio.classList.remove('active');
      videoOptions.classList.add('active');
      audioOptions.classList.remove('active');
      
      // Select the active card under video
      const activeVideoCard = document.querySelector('#video-resolutions-list .quality-card.active');
      state.selectedQuality = activeVideoCard ? activeVideoCard.dataset.quality : '720p';
    } else {
      tabVideo.classList.remove('active');
      tabAudio.classList.add('active');
      videoOptions.classList.remove('active');
      audioOptions.classList.add('active');
      
      // Set audio options selectors
      setupAudioSelectListeners();
      const activeAudioCard = document.querySelector('#audio-options .quality-card.active');
      state.selectedQuality = activeAudioCard ? activeAudioCard.dataset.quality : '320k';
    }
  }

  function setupAudioSelectListeners() {
    const cards = document.querySelectorAll('#audio-options .quality-card');
    cards.forEach(card => {
      // Re-bind to ensure uniqueness
      card.onclick = () => {
        cards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        state.selectedQuality = card.dataset.quality;
      };
    });
  }

  // --- CONTROLLER: INITIATE DOWNLOAD JOB ---
  async function startDownloadJob() {
    if (!state.videoInfo) {
      showToast('Missing video extraction details.', 'danger');
      return;
    }

    const payload = {
      url: state.videoInfo.originalUrl,
      format: state.activeFormat,
      quality: state.selectedQuality,
      title: state.videoInfo.title
    };

    btnStartDownload.disabled = true;
    
    // Prepare progress display
    progressMediaTitle.textContent = state.videoInfo.title;
    const formatName = state.activeFormat === 'video' ? `Video (${state.selectedQuality})` : `Audio (${state.selectedQuality})`;
    progressMediaFormat.textContent = `Processing: ${formatName}`;
    
    // Reset indicators
    updateProgressBar(0, 'Initializing');
    resetStageIndicators();
    clearLogs();
    appendLog('Submitting download job to processing pipeline...', 'info');

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to initialize backend job');
      }

      state.activeJobId = data.jobId;
      showSection('progress-section');
      
      // Connect to SSE stream
      connectSSE(data.jobId);
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Failed to process download request.', 'danger');
      btnStartDownload.disabled = false;
    }
  }

  // --- EVENT SOURCE / SERVER SENT EVENTS STREAM ---
  function connectSSE(jobId) {
    if (state.eventSource) {
      state.eventSource.close();
    }

    appendLog('Starting download... Please wait.', 'info');
    
    const es = new EventSource(`/api/download/progress/${jobId}`);
    state.eventSource = es;
    let sseErrorCount = 0;
    const SSE_MAX_ERRORS = 10;

    es.onmessage = (event) => {
      sseErrorCount = 0; // Reset on successful message
      try {
        const data = JSON.parse(event.data);
        const { status, progress, error } = data;

        // Process status logs and stages
        updateProgressUI(status, progress, error);

        if (status === 'completed') {
          es.close();
          handleJobSuccess();
        } else if (status === 'failed') {
          es.close();
          handleJobFailure(error || 'Process finished with errors.');
        }
      } catch (err) {
        console.error('SSE JSON Error:', err);
      }
    };

    es.onerror = (err) => {
      sseErrorCount++;
      console.error('SSE Error callback:', err);
      if (sseErrorCount >= SSE_MAX_ERRORS) {
        es.close();
        appendLog('Lost connection to download stream. Please try again.', 'error');
        handleJobFailure('Connection to the server was lost. Please try again.');
      } else {
        appendLog('Warning: Still trying to connect to download stream...', 'error');
      }
    };
  }

  // Update progress bar and terminal logs
  function updateProgressUI(status, progress, error) {
    // Status clean names
    let statusLabel = 'Working...';
    if (status === 'initializing') {
      statusLabel = 'Starting...';
      setStageActive('stage-download');
    } else if (status === 'downloading') {
      statusLabel = `Downloading (${progress}%)`;
      setStageActive('stage-download');
    } else if (status === 'merging') {
      statusLabel = 'Combining Files...';
      setStageActive('stage-process');
    } else if (status === 'converting') {
      statusLabel = 'Converting to MP3...';
      setStageActive('stage-process');
    } else if (status === 'completed') {
      statusLabel = 'Done!';
      setStageActive('stage-ready');
    } else if (status === 'failed') {
      statusLabel = 'Error';
    }

    updateProgressBar(progress, statusLabel);

    // Logging triggers to reduce log bloat
    if (status === 'initializing') {
      appendLog('Preparing video on server...', 'normal');
    } else if (status === 'downloading') {
      appendLog(`Downloading... ${progress}% completed.`, 'normal');
    } else if (status === 'merging') {
      appendLog('Combining video and audio streams... This might take a minute.', 'info');
    } else if (status === 'converting') {
      appendLog('Converting audio format to high quality MP3 sound...', 'info');
    }
  }

  // Set the visual progress circle and bar
  function updateProgressBar(percent, statusLabel) {
    progressPercentText.textContent = `${percent}%`;
    progressStatusSlug.textContent = statusLabel;
    progressLinearBar.style.width = `${percent}%`;

    // SVG Circular calculations: Circumference is ~439.8 (Radius = 70)
    const circumference = 2 * Math.PI * 70;
    const offset = circumference - (percent / 100) * circumference;
    progressRingIndicator.style.strokeDashoffset = offset;
  }

  function setStageActive(stageId) {
    const stages = ['stage-download', 'stage-process', 'stage-ready'];
    stages.forEach(id => {
      const el = document.getElementById(id);
      if (id === stageId) {
        el.classList.add('active');
      } else if (stages.indexOf(id) < stages.indexOf(stageId)) {
        // Mark past ones active too
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  }

  function resetStageIndicators() {
    stageDownload.classList.remove('active');
    stageProcess.classList.remove('active');
    stageReady.classList.remove('active');
  }

  // --- LOGGING ENGINE ---
  function appendLog(text, type = 'normal') {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `> ${text}`;
    
    // Simple deduplication of downloading logs to avoid console bloat
    const lastLine = consoleLogs.lastElementChild;
    if (lastLine && lastLine.textContent.includes('Downloading...') && text.includes('Downloading...')) {
      lastLine.textContent = `> ${text}`;
    } else {
      consoleLogs.appendChild(line);
    }
    
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }

  function clearLogs() {
    consoleLogs.innerHTML = '';
  }

  // --- JOB COMPLETION FLOW ---
  function handleJobSuccess() {
    appendLog('Download successfully finished! Loading file...', 'success');
    showToast('Download complete! Starting file download...', 'success');

    // Trigger celebratory confetti if library loaded
    if (typeof confetti === 'function') {
      confetti({
        particleCount: 120,
        spread: 70,
        origin: { y: 0.6 }
      });
    }

    const downloadUrl = `/api/download/file/${state.activeJobId}`;
    
    // Auto-fill success card details
    const ext = state.activeFormat === 'video' ? 'mp4' : 'mp3';
    successMediaTitle.textContent = `${state.videoInfo.title}.${ext}`;
    const metaString = state.activeFormat === 'video' ? `Video Quality: ${state.selectedQuality}` : `Audio Quality: ${state.selectedQuality} (MP3)`;
    successMediaMeta.textContent = `${metaString} | Processing Completed`;
    
    // Bind buttons
    btnDownloadFile.href = downloadUrl;
    
    // Auto launch direct streaming file download via hidden link click
    setTimeout(() => {
      const tempLink = document.createElement('a');
      tempLink.href = downloadUrl;
      tempLink.setAttribute('download', '');
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);
    }, 1200);


    // Jump to success
    setTimeout(() => {
      showSection('success-section');
      btnStartDownload.disabled = false;
    }, 2000);
  }

  function handleJobFailure(errorMsg) {
    appendLog(`Job failed: ${errorMsg}`, 'error');
    showToast(`Download failed: ${errorMsg}`, 'danger');
    
    setTimeout(() => {
      showSection('config-section');
      btnStartDownload.disabled = false;
    }, 3000);
  }


});
