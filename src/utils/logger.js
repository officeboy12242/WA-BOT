/**
 * Logger Utility
 * Centralized logging configuration
 */

import pino from 'pino';

export const logger = pino({ 
    level: 'info',
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                    translateTime: 'yyyy-mm-dd HH:MM:ss'
                },
                level: 'info'
            },
            {
                target: 'pino/file',
                options: { 
                    destination: './bot.log',
                    mkdir: true
                },
                level: 'info'
            }
        ]
    }
});
