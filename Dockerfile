FROM node:20-alpine

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

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create directory for auth data
RUN mkdir -p auth_info_baileys

# Expose port (not really needed for WhatsApp bot but good practice)
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
