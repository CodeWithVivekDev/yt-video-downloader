# StreamVault - Premium YouTube Video Downloader

A sleek, fast, and production-ready YouTube video and audio downloader built with Node.js, Express, and `yt-dlp`. Features a beautifully designed responsive glassmorphism UI, real-time download progress tracking via Server-Sent Events (SSE), and smart extraction fallbacks for maximum reliability.

Made by **Vivek Kumar**.

## ✨ Features
*   **Video & Audio Downloads:** Download high-quality video (MP4) up to 1080p, or extract high-quality audio (MP3).
*   **Maximum Compatibility:** Automatically prioritizes universally compatible H.264 (avc1) codecs over less supported ones (like AV1).
*   **Real-Time Progress:** View live download and conversion status straight from the browser UI without page refreshes.
*   **Dynamic Theme Engine:** Fully functional Light Mode and Dark Mode toggles built into the UI.
*   **Smart Fallbacks:** Implements multiple metadata extraction strategies to aggressively prevent and bypass YouTube rate-limits (429 errors).
*   **Auto Cleanup:** Instantly cleans up temporary server storage immediately after streaming the file to the client.

## 🚀 Getting Started

### Prerequisites
*   [Node.js](https://nodejs.org/en/) (v14 or higher)
*   Python 3 (required for the `yt-dlp` core)

### Installation

1.  Clone the repository and navigate to the root folder:
    ```bash
    git clone https://github.com/yourusername/streamvault.git
    cd streamvault
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Start the application:
    ```bash
    node server.js
    ```
    *The app will automatically start at `http://localhost:3000`*

## 🛠 Tech Stack
*   **Frontend:** HTML5, Vanilla CSS3 (Glassmorphism UI), Vanilla JavaScript (ES6)
*   **Backend:** Node.js, Express.js
*   **Core Extraction:** `yt-dlp` via Python child processes
*   **Transcoding:** `@ffmpeg-installer/ffmpeg`

## 🛡️ License
This project is licensed under the MIT License. Use responsibly and abide by YouTube's terms of service.

---
*Crafted with precision by Vivek Kumar.*
