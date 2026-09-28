@echo off
title WA-BOT watchdog
cd /d "%~dp0"

REM Auto-restarts the bot 5s after any crash; captures stdout+stderr to bot-run.log
REM (bot.log only gets structured pino lines - crash stack traces land in bot-run.log)

:loop
echo [%date% %time%] === bot starting (pid will differ) === >> bot-run.log
node --max-old-space-size=450 bot-new.js >> bot-run.log 2>&1
echo [%date% %time%] === bot EXITED code=%errorlevel% === >> bot-run.log
timeout /t 5 /nobreak >nul
goto loop
