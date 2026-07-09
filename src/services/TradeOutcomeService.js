/**
 * Trade alert outcome journal + calibration (both repos).
 */

import { logger } from '../utils/logger.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';

class TradeOutcomeService {
    constructor(mongoDb = null, config = {}) {
        this._col = mongoDb ? mongoDb.collection('trade_alert_outcomes') : null;
        this._tuneCol = mongoDb ? mongoDb.collection('trade_alert_calibration') : null;
        this.config = config;
    }

    async logPostedAlert({
        symbol,
        side,
        entry,
        stopLoss,
        target1,
        target2,
        confidence,
        confluence,
        groupId = null,
    }) {
        if (!this._col) return;
        await this._col.insertOne({
            alert_date: getTodayDateStrIST(),
            symbol: String(symbol).toUpperCase(),
            side,
            entry,
            stop_loss: stopLoss,
            target1,
            target2,
            confidence,
            confluence,
            group_id: groupId,
            outcome: 'PENDING',
            posted_at: new Date(),
        });
    }

    async getCalibration() {
        if (!this._tuneCol) {
            return { minConfidence: 70, minConfluence: 50, blacklistedSectors: [] };
        }
        const row = await this._tuneCol.findOne({ key: 'global' });
        return {
            minConfidence: row?.min_confidence ?? 70,
            minConfluence: row?.min_confluence ?? 50,
            blacklistedSectors: row?.blacklisted_sectors || [],
        };
    }

    async reviewRecentOutcomes({ lookbackDays = 5 } = {}) {
        if (!this._col || !this._tuneCol) return null;

        const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
        const rows = await this._col.find({ posted_at: { $gte: since } }).toArray();
        if (!rows.length) return null;

        const resolved = rows.filter((r) => r.outcome && r.outcome !== 'PENDING');
        const wins = resolved.filter((r) => r.outcome === 'WIN').length;
        const winRate = resolved.length ? wins / resolved.length : null;

        let minConfidence = 70;
        let minConfluence = 50;
        if (winRate != null) {
            if (winRate > 0.6) {
                minConfidence = 68;
                minConfluence = 48;
            } else if (winRate < 0.4) {
                minConfidence = 75;
                minConfluence = 55;
            }
        }

        await this._tuneCol.updateOne(
            { key: 'global' },
            {
                $set: {
                    min_confidence: minConfidence,
                    min_confluence: minConfluence,
                    win_rate: winRate,
                    reviewed_at: new Date(),
                },
            },
            { upsert: true }
        );

        logger.info(`📊 Trade calibration: winRate=${winRate != null ? (winRate * 100).toFixed(0) + '%' : 'n/a'} conf≥${minConfidence}`);
        return { winRate, minConfidence, minConfluence };
    }
}

export function createTradeOutcomeService(mongoDb, config) {
    return new TradeOutcomeService(mongoDb, config);
}

export default TradeOutcomeService;
