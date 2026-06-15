/**
 * Admin Panel Server
 * Web-based admin panel for QR code authentication and session management
 */

import http from 'http';
import { URL } from 'url';
import { logger } from './logger.js';

class AdminPanel {
    constructor(port = 3000) {
        this.port = port;
        this.server = null;
        this.qrCode = null;
        this.qrCodeText = null;
        this.connectionStatus = 'disconnected';
        this.connectedPhone = null;
        this.authDatabase = null;
        this.adminToken = process.env.ADMIN_TOKEN || 'sassy123';
        this.lastActivity = new Date();
    }

    setAuthDatabase(authDB) {
        this.authDatabase = authDB;
    }

    updateQR(qr, qrText = null) {
        this.qrCode = qr;
        this.qrCodeText = qrText;
        this.connectionStatus = 'waiting_for_scan';
        this.lastActivity = new Date();
    }

    clearQR() {
        this.qrCode = null;
        this.qrCodeText = null;
    }

    setConnected(phoneNumber) {
        this.connectionStatus = 'connected';
        this.connectedPhone = phoneNumber;
        this.qrCode = null;
        this.qrCodeText = null;
        this.lastActivity = new Date();
    }

    setDisconnected() {
        this.connectionStatus = 'disconnected';
        this.connectedPhone = null;
        this.lastActivity = new Date();
    }

    _verifyToken(req) {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const token = url.searchParams.get('token');
        return token === this.adminToken;
    }

    _getAdminHTML() {
        const statusColor = this.connectionStatus === 'connected' ? '#4CAF50' 
            : this.connectionStatus === 'waiting_for_scan' ? '#FF9800' : '#f44336';
        
        const statusText = this.connectionStatus === 'connected' 
            ? `✅ Connected (${this.connectedPhone || 'Unknown'})` 
            : this.connectionStatus === 'waiting_for_scan' 
            ? '📱 Waiting for QR Scan...' 
            : '❌ Disconnected';

        const qrSection = this.qrCode 
            ? `<div class="qr-container">
                <h3>📱 Scan QR Code with WhatsApp</h3>
                <div class="qr-code">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(this.qrCodeText || '')}" alt="QR Code" />
                </div>
                <p class="hint">WhatsApp → Settings → Linked Devices → Link a Device</p>
               </div>`
            : this.connectionStatus === 'connected'
            ? `<div class="connected-box">
                <h3>✅ Bot is Connected!</h3>
                <p>Phone: ${this.connectedPhone || 'Unknown'}</p>
               </div>`
            : `<div class="disconnected-box">
                <h3>⏳ Waiting for Connection...</h3>
                <p>Restart the bot or clear auth to get a new QR code</p>
               </div>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sassy Bot Admin Panel</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #fff;
            padding: 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            padding: 30px 0;
        }
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .header p { color: #888; }
        .status-card {
            background: rgba(255,255,255,0.1);
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 1.2em;
        }
        .status-dot {
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: ${statusColor};
            animation: ${this.connectionStatus === 'waiting_for_scan' ? 'pulse 1.5s infinite' : 'none'};
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .qr-container, .connected-box, .disconnected-box {
            background: rgba(255,255,255,0.05);
            border-radius: 15px;
            padding: 30px;
            text-align: center;
            margin-bottom: 20px;
        }
        .qr-code {
            background: #fff;
            padding: 20px;
            border-radius: 10px;
            display: inline-block;
            margin: 20px 0;
        }
        .qr-code img { display: block; }
        .hint { color: #888; font-size: 0.9em; }
        .connected-box { border: 2px solid #4CAF50; }
        .connected-box h3 { color: #4CAF50; }
        .disconnected-box { border: 2px solid #f44336; }
        .actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .btn {
            flex: 1;
            min-width: 120px;
            padding: 15px 25px;
            border: none;
            border-radius: 10px;
            font-size: 1em;
            cursor: pointer;
            transition: transform 0.2s, opacity 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
        .btn:active { transform: translateY(0); }
        .btn-danger {
            background: linear-gradient(135deg, #f44336, #e91e63);
            color: #fff;
        }
        .btn-primary {
            background: linear-gradient(135deg, #2196F3, #03A9F4);
            color: #fff;
        }
        .btn-success {
            background: linear-gradient(135deg, #4CAF50, #8BC34A);
            color: #fff;
        }
        .info-card {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 15px;
            margin-top: 20px;
            font-size: 0.85em;
            color: #888;
        }
        .info-card p { margin: 5px 0; }
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        .spinner {
            border: 3px solid rgba(255,255,255,0.1);
            border-top: 3px solid #fff;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .alert {
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            display: none;
        }
        .alert-success { background: rgba(76, 175, 80, 0.2); border: 1px solid #4CAF50; }
        .alert-error { background: rgba(244, 67, 54, 0.2); border: 1px solid #f44336; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Sassy Bot</h1>
            <p>Admin Control Panel</p>
        </div>

        <div id="alert" class="alert"></div>

        <div class="status-card">
            <div class="status-indicator">
                <div class="status-dot"></div>
                <span>${statusText}</span>
            </div>
        </div>

        ${qrSection}

        <div class="status-card">
            <h3 style="margin-bottom: 15px;">⚙️ Actions</h3>
            <div class="actions">
                <button class="btn btn-primary" onclick="refreshPage()">🔄 Refresh</button>
                <button class="btn btn-danger" onclick="clearAuth()">🗑️ Clear Session</button>
            </div>
        </div>

        <div id="loading" class="loading">
            <div class="spinner"></div>
            <p>Processing...</p>
        </div>

        <div class="info-card">
            <p>🕐 Last Activity: ${this.lastActivity.toLocaleString()}</p>
            <p>⏱️ Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
            <p>💡 Tip: Clear session if you see "Bad MAC" errors</p>
        </div>
    </div>

    <script>
        const token = new URLSearchParams(window.location.search).get('token');
        
        function showAlert(message, type) {
            const alert = document.getElementById('alert');
            alert.textContent = message;
            alert.className = 'alert alert-' + type;
            alert.style.display = 'block';
            setTimeout(() => alert.style.display = 'none', 5000);
        }

        function showLoading(show) {
            document.getElementById('loading').style.display = show ? 'block' : 'none';
        }

        function refreshPage() {
            window.location.reload();
        }

        async function clearAuth() {
            if (!confirm('⚠️ This will disconnect the bot and require a new QR scan. Continue?')) return;
            
            showLoading(true);
            try {
                const res = await fetch('/api/clear-auth?token=' + token, { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    showAlert('✅ Session cleared! Refreshing...', 'success');
                    setTimeout(() => window.location.reload(), 2000);
                } else {
                    showAlert('❌ ' + (data.error || 'Failed to clear session'), 'error');
                }
            } catch (e) {
                showAlert('❌ Error: ' + e.message, 'error');
            }
            showLoading(false);
        }

        // Auto-refresh every 10 seconds if waiting for QR scan
        ${this.connectionStatus === 'waiting_for_scan' ? 'setTimeout(() => window.location.reload(), 10000);' : ''}
    </script>
</body>
</html>`;
    }

    start() {
        this.server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost:${this.port}`);
            const pathname = url.pathname;

            // Health check (no auth required)
            if (pathname === '/health' || pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    service: 'WhatsApp Course Bot',
                    connection: this.connectionStatus
                }));
                return;
            }

            // Admin panel
            if (pathname === '/admin') {
                if (!this._verifyToken(req)) {
                    res.writeHead(401, { 'Content-Type': 'text/html' });
                    res.end(`
                        <html><body style="font-family:sans-serif;text-align:center;padding:50px;">
                        <h1>🔒 Access Denied</h1>
                        <p>Add ?token=YOUR_ADMIN_TOKEN to the URL</p>
                        </body></html>
                    `);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(this._getAdminHTML());
                return;
            }

            // API: Get status
            if (pathname === '/api/status') {
                if (!this._verifyToken(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: this.connectionStatus,
                    phone: this.connectedPhone,
                    hasQR: !!this.qrCode,
                    uptime: process.uptime()
                }));
                return;
            }

            // API: Clear auth
            if (pathname === '/api/clear-auth' && req.method === 'POST') {
                if (!this._verifyToken(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }

                try {
                    if (this.authDatabase) {
                        await this.authDatabase.clearAll();
                        this.setDisconnected();
                        logger.info('🗑️ Auth cleared via admin panel');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Auth cleared. Restart bot for new QR.' }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Auth database not available' }));
                    }
                } catch (e) {
                    logger.error('Clear auth error:', e.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
                return;
            }

            // 404 for everything else
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        });

        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.warn(`⚠️ Port ${this.port} already in use — admin panel skipped`);
            } else {
                logger.error(`Admin panel server error: ${err.message}`);
            }
        });

        this.server.listen(this.port, () => {
            logger.info(`🏥 Admin panel running on port ${this.port}`);
            logger.info(`🔗 Admin URL: http://localhost:${this.port}/admin?token=${this.adminToken}`);
        });

        return this.server;
    }

    stop() {
        if (this.server) {
            this.server.close();
        }
    }
}

export default AdminPanel;
