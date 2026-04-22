/**
 * Auth Database Model
 * Stores WhatsApp authentication data in SQLite database
 * This allows auth to persist on Render without needing persistent disk
 */

import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

class AuthDatabase {
    constructor(dbFile = 'whatsapp_auth.db') {
        this.dbFile = dbFile;
        this.db = null;
    }

    init() {
        this.db = new Database(this.dbFile);
        
        // Create table for storing auth data as key-value pairs
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS auth_data (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            )
        `);
        
        logger.info('✅ Auth DB ready: ' + this.dbFile);
    }

    // Save auth data (creds or keys)
    // Value should already be stringified by caller
    set(key, value) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO auth_data (key, value, updated_at) 
            VALUES (?, ?, datetime('now'))
        `);
        // Value is already a JSON string from databaseAuthState
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
        stmt.run(key, valueStr);
    }

    // Get auth data
    // Returns raw string, caller will parse it
    get(key) {
        const stmt = this.db.prepare('SELECT value FROM auth_data WHERE key = ?');
        const row = stmt.get(key);
        return row ? row.value : null;
    }

    // Delete auth data
    delete(key) {
        const stmt = this.db.prepare('DELETE FROM auth_data WHERE key = ?');
        stmt.run(key);
    }

    // Clear all auth data (logout)
    clearAll() {
        const stmt = this.db.prepare('DELETE FROM auth_data');
        const result = stmt.run();
        logger.info(`🗑️ Cleared ${result.changes} auth records`);
        return result.changes;
    }

    // Get all keys (for debugging)
    getAllKeys() {
        const stmt = this.db.prepare('SELECT key FROM auth_data');
        return stmt.all().map(row => row.key);
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

export default AuthDatabase;
