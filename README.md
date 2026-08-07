# WA-BOT

WhatsApp multipurpose bot built on [Baileys](https://github.com/WhiskeySockets/Baileys). Originally a free-course poster; now also handles movies, Instagram/stickers, tech news, GitHub trending, group recaps, horoscope, trade alerts, moderation, and owner tools.

**Stack:** Node.js 20+, MongoDB, Baileys 7 (session stored in MongoDB — no local auth folder required).

---

## Features

| Area | What it does |
|------|----------------|
| **Courses** | Polls free courses and posts to activated groups (no duplicates per group) |
| **Movies** | `/movie` search with live progress, daily limits, premium, short links, TMDB upcoming/genre/trending |
| **Instagram** | Download posts/reels (`/insta`); auto-download in DMs and groups with `/instaon` |
| **Stickers** | Create/steal/convert stickers; auto-forward from WhatsApp channels into target groups |
| **News** | Scheduled Inshorts tech digests (`/newson`) |
| **GitHub** | Scheduled trending repos (`/githubon`) |
| **Group recap** | End-of-day AI summary (`/summaryon`) |
| **Trade** | NSE F&O alerts (`/tradelert`), on-demand `/tradenow`, `/swing` momentum setups, and `/expiry` expiry-day index options |
| **Fun** | Horoscope, advice, fun facts, RGB stickers |
| **Moderation** | Warns, message delete helpers, welcome messages |
| **Owner** | Premium/mods, member scrape & broadcast, Drive sources, `/assist` DM persona, `/fix` self-heal, `/deploy` |

Activation (`/activate`) mentions the bot owner with a tappable WhatsApp @mention (DM link). Asking “who is ur owner” (or similar) replies with owner info.

---

## Quick start

```bash
git clone https://github.com/officeboy12242/WA-BOT.git
cd WA-BOT
npm install
cp .env.example .env   # then edit values
npm start
```

1. Set at least `MONGODB_URI` and `OWNER_NUMBERS` in `.env`.
2. Run `npm start` and scan the QR from the terminal/logs with WhatsApp.
3. Auth is saved in MongoDB — redeploys keep the session if the same DB is used.

**Dev (auto-reload):**

```bash
npm run dev
```

**Clear WhatsApp auth in MongoDB** (forces a fresh QR):

```bash
npm run clear-auth
```

---

## Configuration

Copy [`.env.example`](.env.example) → `.env`. Important variables:

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` / `MONGODB_DB_NAME` | Required — data + WA session |
| `OWNER_NUMBERS` | Owner phones/LIDs (comma-separated, country code, no `+`) |
| `MODERATOR_NUMBERS` | Can activate/deactivate groups |
| `BOT_LOG_NUMBER` | Startup + movie search logs |
| `CHECK_INTERVAL` | Course poll interval (seconds, default `180`) |
| `NEWS_POST_TIMES` / `NEWS_TIMEZONE` | Tech news schedule |
| `GITHUB_TRENDING_*` | GitHub digest schedule |
| `STICKER_TARGET_GROUPS` / `STICKER_SOURCE_CHANNELS` | Sticker routing |
| `TMDB_API_KEY` | Upcoming / genre / trending movies |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `NVIDIA_API_KEY` / `OPENROUTER_API_KEY` | LLM features (trade, summary, assist, heal) |
| `ASSIST_OWNER_NAME` / `ASSIST_OWNER_ABOUT` | DM assist persona + bio |
| `ADMIN_TOKEN` | Web admin panel (`/admin?token=…`) |
| `PUBLIC_URL` | Movie short-link base (Render sets `RENDER_EXTERNAL_URL`) |

Full list and comments: **`.env.example`**. Deploy notes: **[DEPLOY.md](DEPLOY.md)** / **[QUICKSTART_RENDER.md](QUICKSTART_RENDER.md)**.

---

## Roles

1. **Owners** (`.env` `OWNER_NUMBERS`) — full control  
2. **Moderators** (env + `/addmod`) — activate groups, feature toggles  
3. **Bot admins** (`/addadmin`) — staff tools  
4. **WhatsApp group admins** — auto-detected in that group  
5. **Anyone** — public commands (`/movie`, `/insta`, `/help`, …)

Exact checks live in `src/commands/registry.js` + `src/commands/access.js`. In-chat: `/help`.

---

## Commands (summary)

Use `/help` on WhatsApp for the live list filtered by your role and chat type.

### Anyone
`/ping` · `/help` · `/movie` · `/upcoming` · `/genre` · `/insta` · `/sticker` · `/steal` · `/toimg` · `/rgb` · `/horo` · `/advice` · `/facts` · `/news` · `/github` · `/tradenow` · `/swing` · `/expiry` · `/posted` · `/status` · `/checklimit`

### Staff (group toggles)
`/activate` · `/deactivate` · `/courson` · `/coursesoff` · `/newson` · `/newsoff` · `/githubon` · `/githuboff` · `/instaon` · `/instaoff` · `/stickeron` · `/stickeroff` · `/movieon` · `/movieoff` · `/summaryon` · `/summaryoff` · `/summarynow` · `/trending` · `/tradelert`

### Admins / moderation
`/setwc` · `/warn` · `/warns` · `/mywarns` · `/clearwarns` · `/dellast` · `/delall` · `/groups` · `/pause` · `/resume` · `/clear` · `/confirm` · `/cancel` · `/addadmin` · `/removeadmin` · `/admins` · `/increaselimit`

### Owner
`/addpremium` · `/removepremium` · `/premium` · `/addmod` · `/removemod` · `/assist` · `/fix` · `/heal` · `/addchannel` · `/removechannel` · `/channels` · `/scrap` · `/scrapmembers` · `/broadcast` · `/grouppost` · `/driveurl` · `/deploy`

---

## Typical group setup

1. Add the bot to the group (promote to admin if you need deletes/warns/kicks).  
2. `/activate` — turns on default group features and shows owner @mention.  
3. Optionally toggle: `/movieon`, `/newson`, `/githubon`, `/instaon`, `/summaryon`, `/tradelert on`, `/setwc on …`.

---

## Project layout

```
whatsapp-bot/
├── bot-new.js                 # Entry point
├── src/
│   ├── commands/              # Registry + access rules
│   ├── config/                # Env → config
│   ├── controllers/           # Commands (movie, trade, stickers, …)
│   │   └── handlers/          # Split command handlers
│   ├── db/                    # Mongo connection
│   ├── models/                # Persistence (groups, auth, warns, …)
│   ├── prompts/               # LLM system prompts
│   ├── services/              # WA, scrapers, LLM routers, APIs
│   └── utils/                 # Messaging, schedulers, permissions
├── scripts/                   # Helpers (clear-auth, …)
├── .env.example
├── DEPLOY.md
└── package.json
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run bot (`bot-new.js`, 450MB heap) |
| `npm run dev` | Watch mode |
| `npm run clear-auth` | Wipe WhatsApp auth in MongoDB |

---

## Notes

- One live instance should hold the WhatsApp session (see instance lock in code) to avoid conflict logouts.  
- Movie search shows an in-chat progress bar, then deletes the loader before sending results.  
- Free users: **5** movie searches/day; premium/staff unlimited.  
- Agent coding conventions for this repo: **[AGENTS.md](AGENTS.md)** (Ponytail / lazy-senior rules).

## License

ISC
