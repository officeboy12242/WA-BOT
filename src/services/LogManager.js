/**
 * Log Manager Service
 * Handles automatic log cleanup and sending
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

class LogManager {
    constructor(logFilePath, adminNumber, checkInterval = 14400000 , deleteAfter = 14400000) { // Check every 10s, delete after 30s
        this.logFilePath = logFilePath;
        this.adminNumber = adminNumber; // WhatsApp number to send logs to
        this.checkInterval = checkInterval;
        this.deleteAfter = deleteAfter; // Time before deleting logs
        this.intervalId = null;
        this.sock = null;
        this.logStartTime = Date.now(); // Track when logging started
    }

    setSocket(sock) {
        this.sock = sock;
    }

    start() {
        logger.info(`📋 Log Manager started - checking every ${this.checkInterval/1000}s, deleting after ${this.deleteAfter/1000}s`);
        
        // Check immediately on start
        this.checkAndCleanLogs();
        
        // Then check periodically
        this.intervalId = setInterval(() => {
            this.checkAndCleanLogs();
        }, this.checkInterval);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('📋 Log Manager stopped');
        }
    }

    async checkAndCleanLogs() {
        try {
            // Check if log file exists
            if (!fs.existsSync(this.logFilePath)) {
                logger.info('📋 No log file found to clean');
                return;
            }

            // Check time since log manager started (not file modification time)
            const timeSinceStart = Date.now() - this.logStartTime;

            logger.info(`📋 Time since bot started: ${Math.floor(timeSinceStart / 1000)} seconds`);

            // If bot has been running for more than deleteAfter time
            if (timeSinceStart > this.deleteAfter) {
                logger.info(`🗑️ Bot running for over ${this.deleteAfter/1000}s, sending logs and resetting...`);
                
                // Send log file to admin
                await this.sendLogToAdmin();
                
                // Delete the log file
                fs.unlinkSync(this.logFilePath);
                logger.info('✅ Log file deleted successfully');
                
                // Reset the timer
                this.logStartTime = Date.now();
            } else {
                logger.info(`⏳ ${Math.floor((this.deleteAfter - timeSinceStart) / 1000)} seconds until log cleanup`);
            }
        } catch (error) {
            logger.error(`Error in log cleanup: ${error.message}`);
        }
    }

    async sendLogToAdmin() {
        try {
            if (!this.sock) {
                logger.warn('⚠️ WhatsApp socket not available, cannot send logs');
                return;
            }

            // Read log file content
            const logContent = fs.readFileSync(this.logFilePath, 'utf-8');
            const logLines = logContent.split('\n');
            const totalLines = logLines.length;

            // Get file size
            const stats = fs.statSync(this.logFilePath);
            const fileSizeKB = (stats.size / 1024).toFixed(2);

            // Create summary message
            let message = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            message += '📋 *BOT LOG REPORT* 📋\n';
            message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            message += `📅 *Date:* ${new Date().toLocaleString()}\n`;
            message += `📊 *Total Lines:* ${totalLines}\n`;
            message += `💾 *File Size:* ${fileSizeKB} KB\n\n`;
            message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            message += '📎 Log file attached below';

            // Format admin number for WhatsApp
            const adminJid = `${this.adminNumber}@s.whatsapp.net`;

            // Send summary message
            await this.sock.sendMessage(adminJid, { text: message });

            // Send log file as document
            await this.sock.sendMessage(adminJid, {
                document: fs.readFileSync(this.logFilePath),
                fileName: `bot-log-${Date.now()}.log`,
                mimetype: 'text/plain',
                caption: '📋 Bot Log File'
            });

            logger.info(`✅ Log file sent to ${this.adminNumber}`);
        } catch (error) {
            logger.error(`Error sending log to admin: ${error.message}`);
        }
    }
}

export default LogManager;
