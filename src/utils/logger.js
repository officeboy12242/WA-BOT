/**
 * Logger Utility
 * Centralized logging configuration
 */

import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

export const logger = pino({ 
    level: logLevel,
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    ignore: 'pid,hostname',
                    translateTime: 'yyyy-mm-dd HH:MM:ss'
                },
                level: logLevel
            },
            {
                target: 'pino/file',
                options: { 
                    destination: './bot.log',
                    mkdir: true
                },
                level: logLevel
            }
        ]
    }
});
