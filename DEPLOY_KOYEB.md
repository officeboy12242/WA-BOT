# Deploy WhatsApp Bot to Koyeb

Koyeb is a great alternative to Render — **the free tier doesn't sleep**, so your bot stays online 24/7.

## Why Koyeb over Render?

| Feature | Render (Free) | Koyeb (Free) |
|---------|---------------|--------------|
| Cold starts | Yes (sleeps after 15 min) | No (always on) |
| RAM | 512 MB | 512 MB |
| CPU | Shared | 1 vCPU |
| Sleep | 15 min inactivity | Never |
| Region | Singapore | Frankfurt / Washington |
| Docker support | Yes | Yes |

---

## Option A: Deploy from GitHub (Recommended)

### Step 1: Push to GitHub

```bash
git add .
git commit -m "Deploy to Koyeb"
git push origin main
```

### Step 2: Create Koyeb Account

1. Go to https://app.koyeb.com
2. Sign up with GitHub (or email)

### Step 3: Create Service

1. Click **"Create Service"**
2. Select **"GitHub"** as the source
3. Connect your repository
4. Configure:
   - **Name:** `whatsapp-bot`
   - **Dockerfile:** `Dockerfile` (detected automatically)
   - **Branch:** `main`
5. Click **"Deploy"**

### Step 4: Add Environment Variables

In the service dashboard → **"Variables & Secrets"** tab, add:

```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?appName=telegramUdemy
MONGODB_DB_NAME=telegramUdemy
OWNER_NUMBERS=918830285258
STICKER_TARGET_GROUPS=917887499710-1621848242@g.us
STICKER_PACK_NAME=Created By Sassy Bot 🤖
CHECK_INTERVAL=180
ADMIN_TOKEN=sassy123
```

### Step 5: Set Instance Type

In the **"Settings"** tab:
- **Instance:** Nano (free, 512 MB)
- **Scalability:** Min 1, Max 1 (keeps it always on)

### Step 6: Check Logs

1. Go to **"Logs"** tab
2. Look for QR code
3. Scan with WhatsApp on your phone

---

## Option B: Deploy with Koyeb CLI

### Step 1: Install Koyeb CLI

```bash
# macOS / Linux
curl -fsSL https://get.koyeb.com | sh

# Windows (PowerShell)
iwr -useb get.koyeb.com | iex
```

### Step 2: Authenticate

```bash
koyeb login
# Opens browser — sign in and copy the token
```

### Step 3: Create Service

```bash
koyeb service create whatsapp-bot \
  --git https://github.com/YOUR_USER/REPO \
  --git-branch main \
  --dockerfile Dockerfile \
  --type nano \
  --ports 3000:http \
  --env NODE_ENV=production \
  --env NODE_VERSION=22
```

### Step 4: Set Secrets

```bash
koyeb secret create mongodb_uri \
  --value "mongodb+srv://user:pass@cluster.mongodb.net/?appName=telegramUdemy"

koyeb secret create owner_numbers \
  --value "918830285258"

koyeb service update whatsapp-bot \
  --env MONGODB_URI=@mongodb_uri \
  --env MONGODB_DB_NAME=telegramUdemy \
  --env OWNER_NUMBERS=@owner_numbers \
  --env STICKER_PACK_NAME="Created By Sassy Bot 🤖" \
  --env CHECK_INTERVAL=180
```

### Step 5: View Logs

```bash
koyeb logs whatsapp-bot --follow
```

### Step 6: Scan QR Code

The QR code will appear in the logs. Scan with WhatsApp.

---

## Option C: Deploy with koyeb.yaml Spec

### Step 1: Apply the spec

```bash
koyeb service init --file koyeb.yaml
```

### Step 2: Set secrets

```bash
koyeb secret create mongodb_uri --value "mongodb+srv://..."
koyeb secret create owner_numbers --value "918830285258"

koyeb service update whatsapp-bot-service \
  --env MONGODB_URI=@mongodb_uri \
  --env OWNER_NUMBERS=@owner_numbers
```

---

## Keeping Bot Alive

Koyeb free tier **doesn't sleep** — no keep-alive needed!

If you need an external ping (e.g., monitoring):
- UptimeRobot: https://uptimerobot.com
- Koyeb apps get a public URL: `https://YOUR_APP.koyeb.app`
- Ping `https://YOUR_APP.koyeb.app` every 5 minutes

---

## Viewing Logs

```bash
# Real-time logs
koyeb logs whatsapp-bot --follow

# Or in the dashboard:
# Go to your service → "Logs" tab
```

---

## Updating the Bot

```bash
git add .
git commit -m "Update bot"
git push origin main
```

Koyeb auto-deploys on push (if connected to GitHub).

---

## Environment Variables Reference

All variables from `.env.example` work. Key ones to set:

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | ✅ | MongoDB connection string |
| `MONGODB_DB_NAME` | ✅ | Database name |
| `OWNER_NUMBERS` | ✅ | Your phone number(s) |
| `STICKER_TARGET_GROUPS` | Recommended | Groups for sticker forwarding |
| `CHECK_INTERVAL` | Recommended | Course check interval (seconds) |
| `ADMIN_TOKEN` | Recommended | Web admin panel token |
| `BOT_LOG_NUMBER` | Optional | Phone for bot notifications |
| `GITHUB_TOKEN` | Optional | GitHub API token |
| `GITHUB_REPO` | Optional | GitHub repo for /github command |

---

## Troubleshooting

**Bot not starting:**
- Check logs for errors
- Verify all env vars are set
- Ensure `MONGODB_URI` is correct

**QR code not appearing:**
- Clear `auth_data` collection in MongoDB
- Redeploy the service
- New QR will appear in logs

**Movie links show `localhost:8000/d/…`:**
- Bot auto-uses Koyeb's injected `KOYEB_PUBLIC_DOMAIN` — redeploy so that code is live
- Confirm the service is a **public web** service (port exposed), not private-only

**Bot disconnects:**
- Check WhatsApp session expiry
- Rescan QR code
- Verify MongoDB is reachable

**Out of memory:**
- Koyeb free tier has 512 MB
- Bot uses `--max-old-space-size=450`
- If OOM, consider upgrading to a paid plan

---

## Useful Commands

```bash
# List services
koyeb service list

# Service status
koyeb service get whatsapp-bot

# Restart
koyeb service restart whatsapp-bot

# Delete
koyeb service delete whatsapp-bot
```

---

## Cost

**Free tier:** $0/month (Nano instance, 512 MB, 1 vCPU)
**Paid tier:** From $5/month (when you outgrow free)
