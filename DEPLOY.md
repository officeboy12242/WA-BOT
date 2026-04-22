# Deploy WhatsApp Course Bot to Render

## Prerequisites
- GitHub account
- Render account (free tier works)
- Your bot code pushed to GitHub

## Step 1: Push Code to GitHub

```bash
cd whatsapp-bot
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/whatsapp-course-bot.git
git push -u origin main
```

## Step 2: Create Render Account

1. Go to https://render.com
2. Sign up with GitHub
3. Authorize Render to access your repositories

## Step 3: Create New Web Service

1. Click "New +" → "Web Service"
2. Connect your GitHub repository
3. Configure:
   - **Name:** whatsapp-course-bot
   - **Region:** Singapore (or closest to you)
   - **Branch:** main
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free

## Step 4: Add Environment Variables

In Render dashboard, go to "Environment" tab and add:

```
OWNER_NUMBERS=918830285258
STICKER_TARGET_GROUPS=917887499710-1621848242@g.us
STICKER_PACK_NAME=Created By Sassy Bot 🤖
STICKER_PACK_AUTHOR=
CHECK_INTERVAL=180
```

## Step 5: Add Persistent Disk (Important!)

1. Go to "Disks" tab
2. Click "Add Disk"
3. Configure:
   - **Name:** bot-data
   - **Mount Path:** `/opt/render/project/src/auth_info_baileys`
   - **Size:** 1 GB (free tier)

This ensures your WhatsApp session persists across deployments.

## Step 6: Deploy

1. Click "Create Web Service"
2. Wait for deployment (5-10 minutes)
3. Check logs for QR code

## Step 7: Scan QR Code

1. Go to "Logs" tab in Render
2. Look for QR code in ASCII format
3. Scan with WhatsApp on your phone
4. Bot will connect and start working

## Important Notes

### QR Code Scanning
- The QR code will appear in the logs
- You have ~30 seconds to scan it
- If you miss it, the bot will generate a new one
- Once scanned, session is saved to disk

### Keeping Bot Alive
Render free tier sleeps after 15 minutes of inactivity. To keep it alive:

**Option 1: Use Cron Job (Recommended)**
Add this to render.yaml:
```yaml
- type: cron
  name: keep-alive
  schedule: "*/10 * * * *"
  command: "curl https://your-app.onrender.com"
```

**Option 2: External Ping Service**
Use services like:
- UptimeRobot (https://uptimerobot.com)
- Cron-job.org (https://cron-job.org)

Set them to ping your Render URL every 10 minutes.

### Viewing Logs

Real-time logs sent to WhatsApp (917887499710) every 4 hours automatically.

To view in Render:
1. Go to your service dashboard
2. Click "Logs" tab
3. See real-time output

### Updating the Bot

```bash
git add .
git commit -m "Update bot"
git push
```

Render will automatically redeploy.

### Troubleshooting

**Bot not starting:**
- Check logs for errors
- Verify environment variables are set
- Ensure disk is mounted correctly

**QR code not appearing:**
- Delete `auth_info_baileys` folder from disk
- Redeploy
- New QR will appear

**Bot disconnects:**
- Check if WhatsApp session expired
- Rescan QR code
- Ensure disk is persistent

**Stickers not forwarding:**
- Verify `STICKER_TARGET_GROUPS` is set correctly
- Check group IDs in logs
- Ensure bot is in those groups

## Alternative: Deploy with Docker

If you prefer Docker:

```bash
docker build -t whatsapp-bot .
docker run -d \
  -e OWNER_NUMBERS=918830285258 \
  -e STICKER_TARGET_GROUPS=917887499710-1621848242@g.us \
  -e STICKER_PACK_NAME="Created By Sassy Bot 🤖" \
  -v $(pwd)/auth_info_baileys:/app/auth_info_baileys \
  whatsapp-bot
```

## Support

For issues:
1. Check logs first
2. Verify environment variables
3. Ensure WhatsApp session is active
4. Check disk persistence

## Features Enabled

✅ Auto course posting every 3 minutes
✅ Sticker forwarding from any group
✅ Per-group duplicate prevention
✅ Auto log cleanup (every 4 hours)
✅ Group admin auto-detection
✅ Owner-based permissions
✅ Per-group statistics
✅ Persistent WhatsApp session
