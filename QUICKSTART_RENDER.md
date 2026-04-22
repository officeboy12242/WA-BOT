# Quick Start: Deploy to Render in 5 Minutes

## Step 1: Push to GitHub (2 minutes)

```bash
cd whatsapp-bot
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/whatsapp-bot.git
git push -u origin main
```

## Step 2: Deploy on Render (3 minutes)

1. Go to https://render.com and sign in with GitHub
2. Click **"New +"** → **"Web Service"**
3. Select your repository
4. Fill in:
   - **Name:** `whatsapp-course-bot`
   - **Region:** Singapore
   - **Branch:** main
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free

5. Click **"Advanced"** and add Environment Variables:
   ```
   OWNER_NUMBERS=918830285258
   STICKER_TARGET_GROUPS=917887499710-1621848242@g.us
   STICKER_PACK_NAME=Created By Sassy Bot 🤖
   STICKER_PACK_AUTHOR=
   ```

6. Add Persistent Disk:
   - Click **"Add Disk"**
   - Name: `bot-data`
   - Mount Path: `/opt/render/project/src/auth_info_baileys`
   - Size: 1 GB

7. Click **"Create Web Service"**

## Step 3: Scan QR Code

1. Wait for deployment (5-10 minutes)
2. Go to **"Logs"** tab
3. Look for QR code (ASCII art)
4. Scan with WhatsApp
5. Done! Bot is running 24/7

## Keep Bot Alive (Prevent Sleep)

Render free tier sleeps after 15 min. Use UptimeRobot:

1. Go to https://uptimerobot.com
2. Create free account
3. Add new monitor:
   - Type: HTTP(s)
   - URL: `https://your-app.onrender.com/health`
   - Interval: 5 minutes
4. Save

Now your bot stays alive 24/7!

## View Logs

Logs are automatically sent to WhatsApp (917887499710) every 4 hours.

Or view in Render dashboard → Logs tab.

## Update Bot

```bash
git add .
git commit -m "Update"
git push
```

Render auto-deploys!

## Troubleshooting

**QR not showing?**
- Wait 2-3 minutes after deployment
- Refresh logs page

**Bot disconnects?**
- Check if disk is mounted
- Rescan QR code

**Stickers not forwarding?**
- Verify group IDs in env vars
- Check bot is in those groups

## Done! 🎉

Your bot is now running 24/7 on Render for FREE!
