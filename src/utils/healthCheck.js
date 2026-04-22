/**
 * Health Check Server
 * Keeps Render service alive by responding to HTTP requests
 */

import http from 'http';
import { logger } from './logger.js';

export function startHealthCheckServer(port = 3000) {
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                service: 'WhatsApp Course Bot'
            }));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    server.listen(port, () => {
        logger.info(`🏥 Health check server running on port ${port}`);
    });

    return server;
}
