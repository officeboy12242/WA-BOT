/**
 * In-memory bot telemetry — live feed + counters for the mission-control dashboard.
 * Optional Mongo persist for longer analytics windows.
 */

import { getTodayDateStrIST } from './dateIST.js';

const MAX_EVENTS = 400;

class BotTelemetry {
    constructor() {
        /** @type {object[]} */
        this.events = [];
        /** @type {Set<(ev: object) => void>} */
        this.listeners = new Set();
        /** @type {Map<string, number>} */
        this.commandCounts = new Map();
        /** @type {Map<string, number>} */
        this.postCounts = new Map();
        this.errorCount = 0;
        this.commandOk = 0;
        this.commandFail = 0;
        this.latencySum = 0;
        this.latencyN = 0;
        this._day = '';
        /** @type {import('mongodb').Collection|null} */
        this._col = null;
    }

    async init(mongoDb) {
        if (!mongoDb) return;
        this._col = mongoDb.collection('bot_events');
        await this._col.createIndex({ at: 1 }, { expireAfterSeconds: 14 * 24 * 3600, name: 'bot_events_ttl' });
        await this._col.createIndex({ type: 1, at: -1 }, { name: 'bot_events_type_at' });
    }

    _rollDay() {
        const day = getTodayDateStrIST();
        if (day === this._day) return;
        this._day = day;
        this.commandCounts.clear();
        this.postCounts.clear();
        this.errorCount = 0;
        this.commandOk = 0;
        this.commandFail = 0;
        this.latencySum = 0;
        this.latencyN = 0;
    }

    /**
     * @param {string} type command|post|error|system|movie
     * @param {object} [payload]
     */
    track(type, payload = {}) {
        this._rollDay();
        const ev = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type,
            at: new Date().toISOString(),
            ...payload,
        };

        this.events.push(ev);
        if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
        }

        if (type === 'command') {
            const key = String(payload.cmd || 'unknown');
            this.commandCounts.set(key, (this.commandCounts.get(key) || 0) + 1);
            if (payload.status === 'ok') {
                this.commandOk += 1;
                if (Number.isFinite(payload.ms)) {
                    this.latencySum += payload.ms;
                    this.latencyN += 1;
                }
            } else if (payload.status === 'err') {
                this.commandFail += 1;
            }
        } else if (type === 'post') {
            const key = String(payload.kind || 'other');
            this.postCounts.set(key, (this.postCounts.get(key) || 0) + 1);
        } else if (type === 'error') {
            this.errorCount += 1;
        }

        for (const fn of this.listeners) {
            try {
                fn(ev);
            } catch {
                // ignore listener errors
            }
        }

        if (this._col && (type === 'command' || type === 'post' || type === 'error')) {
            void this._col.insertOne({ ...ev, created_at: new Date() }).catch(() => {});
        }

        return ev;
    }

    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    recent(limit = 80) {
        return this.events.slice(-limit).reverse();
    }

    liveStats() {
        this._rollDay();
        const commands = [...this.commandCounts.entries()]
            .map(([cmd, count]) => ({ cmd, count }))
            .sort((a, b) => b.count - a.count);
        const posts = Object.fromEntries(this.postCounts);
        return {
            day: this._day,
            commandsToday: commands,
            postsToday: posts,
            commandOk: this.commandOk,
            commandFail: this.commandFail,
            errorsToday: this.errorCount,
            avgLatencyMs: this.latencyN ? Math.round(this.latencySum / this.latencyN) : 0,
            recent: this.recent(60),
        };
    }
}

export const botTelemetry = new BotTelemetry();
export default botTelemetry;
