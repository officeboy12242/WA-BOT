# WhatsApp Course Bot

Automatically posts free courses from an API to WhatsApp groups with per-group tracking and management.

## Features

- ✅ **Auto-posting** - Automatically posts free courses every 3 minutes
- ✅ **Per-group tracking** - Each group has independent course history
- ✅ **No duplicates** - Courses are only posted once per group
- ✅ **Group-based stats** - View statistics for each group separately
- ✅ **Auto admin detection** - Group admins automatically get permissions
- ✅ **Owner system** - Configure owners via .env file
- ✅ **Auto log cleanup** - Logs are sent to admin and deleted after 1 minute (configurable)
- ✅ **Language filtering** - Only posts English, Hindi, and Urdu courses

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file:

```env
# Bot Owner Numbers (comma-separated, no spaces)
OWNER_NUMBERS=918830285258,917887499710

# Course Check Interval (seconds)
CHECK_INTERVAL=180

# Database File
DB_FILE=posted_courses.db
```

## Usage

Start the bot:

```bash
npm start
```

On first run, scan the QR code with WhatsApp.

## Commands

### General Commands
- `/posted` - View course statistics (group-specific or all groups)
- `/status` - Check bot status
- `/help` - Show help message

### Admin Commands (Group admins & Owners)
- `/activate` - Activate group for course posting
- `/deactivate` - Deactivate group
- `/clear` - Delete posted courses (group-specific or all)
- `/pause` - Pause automatic posting
- `/resume` - Resume automatic posting

### Owner Commands
- `/groups` - List all active groups
- `/admins` - List all bot owners

## Permission System

1. **Owners** (from .env) - Full access everywhere
2. **Group Admins** (auto-detected) - Access only in their groups
3. **Regular Users** - No admin access

## Log Management

- Logs are automatically checked every 1 minute
- When logs are older than 1 minute:
  - Sent to configured admin number (917887499710)
  - Deleted from disk
- Change interval in `bot-new.js` (60000 = 1 minute)

## Project Structure

```
whatsapp-bot/
├── src/
│   ├── config/
│   │   └── config.js          # Configuration
│   ├── controllers/
│   │   ├── CommandController.js   # Command handling
│   │   └── CourseController.js    # Course posting logic
│   ├── models/
│   │   ├── CourseAPI.js       # API integration
│   │   ├── Database.js        # Course database
│   │   └── GroupManager.js    # Group & admin management
│   ├── services/
│   │   ├── WhatsAppService.js # WhatsApp connection
│   │   └── LogManager.js      # Log cleanup & sending
│   └── utils/
│       ├── logger.js          # Logging utility
│       ├── messageFormatter.js # Message formatting
│       └── permissions.js     # Permission helpers
├── bot-new.js                 # Main entry point
├── .env                       # Configuration
└── package.json
```

## Database Schema

### posted_courses
- `course_id` - Course ID
- `group_id` - WhatsApp group ID
- `name` - Course name
- `url` - Course URL
- `posted_at` - Timestamp

### bot_groups
- `group_id` - WhatsApp group ID
- `group_name` - Group name
- `is_active` - Active status
- `activated_at` - Activation timestamp
- `activated_by` - Admin who activated

## Notes

- Each group maintains independent course history
- Clearing courses in one group doesn't affect others
- New groups receive all available courses when activated
- Bot automatically reconnects on disconnect
