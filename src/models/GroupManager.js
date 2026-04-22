/**
 * Group Manager Model
 * Handles active groups and admin management
 */

import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

class GroupManager {
    constructor(dbFile = 'bot_groups.db') {
        this.dbFile = dbFile;
        this.db = null;
    }

    init() {
        this.db = new Database(this.dbFile);
        
        // Create tables
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS active_groups (
                group_id TEXT PRIMARY KEY,
                group_name TEXT,
                activated_by TEXT,
                activated_at TEXT DEFAULT (datetime('now')),
                is_active INTEGER DEFAULT 1
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS admins (
                phone_number TEXT PRIMARY KEY,
                added_at TEXT DEFAULT (datetime('now'))
            )
        `);

        logger.info('✅ Group Manager DB ready: ' + this.dbFile);
    }

    // ─── Admin Management ─────────────────────────────────────────────────────

    setOwnerNumbers(ownerNumbers) {
        this.ownerNumbers = ownerNumbers || [];
    }

    isOwner(phoneNumber) {
        return this.ownerNumbers.includes(phoneNumber);
    }

    async isGroupAdmin(sock, groupId, phoneNumber) {
        try {
            const groupMetadata = await sock.groupMetadata(groupId);
            const participant = groupMetadata.participants.find(p => p.id.includes(phoneNumber));
            return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
        } catch (error) {
            return false;
        }
    }

    async isAdmin(sock, chatId, phoneNumber) {
        // Owners always have permission
        if (this.isOwner(phoneNumber)) {
            return true;
        }
        
        // Check if it's a group and user is group admin
        if (chatId.endsWith('@g.us')) {
            return await this.isGroupAdmin(sock, chatId, phoneNumber);
        }
        
        return false;
    }

    getAllOwners() {
        return this.ownerNumbers.map(phone => ({ phone_number: phone }));
    }

    // ─── Group Management ─────────────────────────────────────────────────────

    activateGroup(groupId, groupName, activatedBy) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO active_groups (group_id, group_name, activated_by, is_active) 
            VALUES (?, ?, ?, 1)
        `);
        stmt.run(groupId, groupName, activatedBy);
        logger.info(`✅ Group activated: ${groupName} (${groupId}) by ${activatedBy}`);
    }

    deactivateGroup(groupId) {
        const stmt = this.db.prepare('UPDATE active_groups SET is_active = 0 WHERE group_id = ?');
        const result = stmt.run(groupId);
        logger.info(`🛑 Group deactivated: ${groupId}`);
        return result.changes > 0;
    }

    isGroupActive(groupId) {
        const stmt = this.db.prepare('SELECT is_active FROM active_groups WHERE group_id = ?');
        const row = stmt.get(groupId);
        return row ? row.is_active === 1 : false;
    }

    getActiveGroups() {
        const stmt = this.db.prepare('SELECT * FROM active_groups WHERE is_active = 1 ORDER BY activated_at DESC');
        return stmt.all();
    }

    getAllGroups() {
        const stmt = this.db.prepare('SELECT * FROM active_groups ORDER BY activated_at DESC');
        return stmt.all();
    }

    getGroupInfo(groupId) {
        const stmt = this.db.prepare('SELECT * FROM active_groups WHERE group_id = ?');
        return stmt.get(groupId);
    }

    getGroupCount() {
        const active = this.db.prepare('SELECT COUNT(*) as count FROM active_groups WHERE is_active = 1').get().count;
        const total = this.db.prepare('SELECT COUNT(*) as count FROM active_groups').get().count;
        return { active, total };
    }

    // ─── Utility ──────────────────────────────────────────────────────────────

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

export default GroupManager;
