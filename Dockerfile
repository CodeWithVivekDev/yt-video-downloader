FROM node:20-bullseye-slim

# Install Python 3, pip, ffmpeg, and curl
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python-is-python3 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp and the PO Token provider plugin
# The bgutil plugin auto-generates fresh Proof-of-Origin tokens per request,
# which is required to bypass YouTube's bot detection on datacenter IPs.
RUN pip3 install --upgrade "yt-dlp[default]" bgutil-ytdlp-pot-provider && \
    python -m yt_dlp --version && \
    ffmpeg -version | head -1

# Download the actual bgutil-pot Rust binary server which the plugin connects to
RUN curl -L https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-linux-x86_64 -o /usr/local/bin/bgutil-pot && \
    chmod +x /usr/local/bin/bgutil-pot

# Set up working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Create the temp directory explicitly for downloads
RUN mkdir -p temp

# Expose the application port
EXPOSE 3000

# Start the PO token provider server in background, then start the Node.js app.
CMD sh -c 'bgutil-pot server --port 4416 & sleep 3 && npm start'
