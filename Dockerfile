FROM node:22-alpine

# Install dependencies for sharp and other native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies and clean cache to save memory
RUN npm ci --omit=dev && npm cache clean --force

# Copy application files
COPY . .

# Expose port (not really needed for WhatsApp bot but good practice)
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
