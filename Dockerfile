FROM node:18-bullseye-slim

# Install Python 3, pip, and ffmpeg (which provides ffprobe as well)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python-is-python3 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (always get latest version for best YouTube compatibility)
RUN pip3 install --upgrade yt-dlp

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

# Start the application
CMD [ "npm", "start" ]
