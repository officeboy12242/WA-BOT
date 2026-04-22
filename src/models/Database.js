/**
 * Database Model
 * Handles all database operations for posted courses
 */

import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

class DatabaseModel {
    constructor(dbFile = 'posted_courses.db') {
        this.dbFile = dbFile;
        this.db = null;
    }

    init() {
        this.db = new Database(this.dbFile);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS posted_courses (
                course_id TEXT,
                group_id TEXT,
                name TEXT,
                url TEXT,
                posted_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (course_id, group_id)
            )
        `);
        logger.info('✅ SQLite DB ready: ' + this.dbFile);
    }

    isPosted(courseId, groupId) {
        const stmt = this.db.prepare('SELECT 1 FROM posted_courses WHERE course_id = ? AND group_id = ?');
        const row = stmt.get(String(courseId), groupId);
        return row !== undefined;
    }

    markPosted(courseId, groupId, name, url) {
        const stmt = this.db.prepare('INSERT OR IGNORE INTO posted_courses (course_id, group_id, name, url) VALUES (?, ?, ?, ?)');
        stmt.run(String(courseId), groupId, name, url);
    }

    getTotalPosted(groupId = null) {
        if (groupId) {
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM posted_courses WHERE group_id = ?');
            const row = stmt.get(groupId);
            return row ? row.count : 0;
        }
        const stmt = this.db.prepare('SELECT COUNT(*) as count FROM posted_courses');
        const row = stmt.get();
        return row ? row.count : 0;
    }

    getPostedStats(groupId = null) {
        const whereClause = groupId ? 'WHERE group_id = ?' : '';
        const params = groupId ? [groupId] : [];
        
        const total = this.db.prepare(`SELECT COUNT(*) as count FROM posted_courses ${whereClause}`).get(...params).count;
        const today = this.db.prepare(`
            SELECT COUNT(*) as count FROM posted_courses 
            ${whereClause ? whereClause + ' AND' : 'WHERE'} DATE(posted_at) = DATE('now')
        `).get(...params).count;
        const thisWeek = this.db.prepare(`
            SELECT COUNT(*) as count FROM posted_courses 
            ${whereClause ? whereClause + ' AND' : 'WHERE'} DATE(posted_at) >= DATE('now', '-7 days')
        `).get(...params).count;
        const thisMonth = this.db.prepare(`
            SELECT COUNT(*) as count FROM posted_courses 
            ${whereClause ? whereClause + ' AND' : 'WHERE'} DATE(posted_at) >= DATE('now', 'start of month')
        `).get(...params).count;
        
        return { total, today, thisWeek, thisMonth };
    }

    clearAllPosted(groupId = null) {
        if (groupId) {
            const stmt = this.db.prepare('DELETE FROM posted_courses WHERE group_id = ?');
            const result = stmt.run(groupId);
            return result.changes;
        }
        const stmt = this.db.prepare('DELETE FROM posted_courses');
        const result = stmt.run();
        return result.changes;
    }

    getRecentCourses(limit = 5) {
        const stmt = this.db.prepare(`
            SELECT * FROM posted_courses 
            ORDER BY posted_at DESC 
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

export default DatabaseModel;
