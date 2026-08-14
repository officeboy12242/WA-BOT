/**
 * Price tracker handlers: /price (and /price history).
 *
 * Usage:
 *   /price <amazon-link-or-product-text>  — scan Indian stores, rank cheapest
 *   /price history <link-or-text>         — stored price snapshots over time
 */

import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';
import {
    trackProduct,
    extractAmazonAsin,
    extractFlipkartUrl,
    sanitizeFlipkartUrl,
    resolveFlipkartPid,
    fetchPriceHistory,
    savePriceSnapshots,
    getPriceSnapshots,
    shortTitle,
    cleanPrice,
} from '../../services/PriceTrackerService.js';

const inr = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);

function siteEmoji(site) {
    const s = String(site || '').toLowerCase();
    if (s === 'amazon') return '🅰️';
    if (s === 'flipkart') return '🅵';
    if (s === 'myntra') return '🅼';
    if (s === 'ajio') return '🅰';
    if (s === 'snapdeal') return '🆂';
    if (s === 'tata cliq' || s === 'Tata CLiQ') return '🆃';
    return '🛒';
}

/** Build the main comparison card. */
export function formatTrackCard(result) {
    const { query, amazon, flipkart, history, offers, asin } = result;
    const tracked = amazon || flipkart;
    const trackedSite = amazon ? 'Amazon' : flipkart ? 'Flipkart' : null;
    const lines = [];

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🏷️ *PRICE TRACKER* 🏷️');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`🛒 *${shortTitle(query, 80)}*`);
    if (tracked?.rating) lines.push(`⭐ ${tracked.rating}/5 · ${tracked.availability ? `_${tracked.availability}_` : ''}`.trim());
    lines.push('');

    if (!offers.length) {
        lines.push('😕 _No prices found right now._');
        lines.push('_Try a more specific product name, or paste an Amazon.in link._');
    } else {
        const maxOffers = Math.min(config?.PRICE_TRACKER_MAX_OFFERS || 8, 8);
        const best = offers[0];
        const bestIsTracked = best.site === trackedSite && tracked;
        lines.push(`💰 *Best price: ${inr(best.price)}* — ${best.site} ${siteEmoji(best.site)}`);
        // Only compare against the tracked product when the best offer IS it —
        // a different-brand cheap lookalike must not claim the tracked MRP savings.
        if (bestIsTracked && tracked?.mrp && tracked.mrp > best.price) {
            const save = Math.round(((tracked.mrp - best.price) / tracked.mrp) * 100);
            lines.push(`   _MRP ${inr(tracked.mrp)} · save ${save}%_`);
        } else if (bestIsTracked && tracked?.price && best.price === tracked.price && tracked.mrp) {
            lines.push(`   _MRP ${inr(tracked.mrp)}_`);
        } else if (tracked?.price && best.price < tracked.price) {
            const diff = Math.round(((tracked.price - best.price) / tracked.price) * 100);
            lines.push(`   _${diff}% below the tracked ${trackedSite} price (${inr(tracked.price)})_`);
        }
        if (best.url) lines.push(`   🔗 ${best.url}`);
        lines.push('');

        lines.push('┌─ *ALL OFFERS (cheapest first)* ─');
        offers.slice(0, maxOffers).forEach((o, i) => {
            const tag = i === 0 ? '🔥 ' : '';
            lines.push(`│ ${tag}${i + 1}. ${inr(o.price)} · *${o.site}* ${siteEmoji(o.site)}`);
            if (o.url) lines.push(`│    🔗 ${o.url}`);
            lines.push('│');
        });
        lines.push('└────────────────────────────');
        lines.push('');
    }

    if (history) {
        lines.push(`📈 *${trackedSite || ''} price history*`.replace('  ', ' '));
        const parts = [];
        if (history.lowest) parts.push(`Low ${inr(history.lowest)}`);
        if (history.average) parts.push(`Avg ${inr(history.average)}`);
        if (history.highest) parts.push(`High ${inr(history.highest)}`);
        if (history.current) {
            parts.push(`Now ${inr(history.current)}${history.currentDate ? ` (${history.currentDate})` : ''}`);
        }
        lines.push(`   ${parts.join(' · ')}`);
        if (history.mrp) lines.push(`   MRP ${inr(history.mrp)}`);
        if (history.url) lines.push(`   📊 ${history.url}`);
        lines.push('');
    }

    lines.push(`_Data: Amazon · Flipkart · Myntra · Ajio · Snapdeal · Tata CLiQ · pricehistory.app_`);
    lines.push(`_Checked ${new Date().toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit' })} IST_`);
    if (asin) lines.push(`_ASIN ${asin} — re-check with the same link to build history_`);
    else if (flipkart?.pid) lines.push(`_Flipkart ${flipkart.pid} — re-check with the same link to build history_`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
}

/** Build the history card from stored snapshots + past prices (pricehistory.app). */
export function formatHistoryCard(result) {
    const { query, asin, idKey, external } = result;
    const lines = [];
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📈 *PRICE HISTORY* 📈');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`🛒 *${shortTitle(query, 80)}*`);
    lines.push('');

    // Past prices from pricehistory.app — works immediately for any link,
    // no need to wait for Mongo snapshots to accumulate.
    if (external && Object.keys(external).length) {
        lines.push('📊 *Past prices (pricehistory.app)*');
        const parts = [];
        if (external.lowest) parts.push(`Low ${inr(external.lowest)}`);
        if (external.average) parts.push(`Avg ${inr(external.average)}`);
        if (external.highest) parts.push(`High ${inr(external.highest)}`);
        if (external.current) {
            parts.push(`Now ${inr(external.current)}${external.currentDate ? ` (${external.currentDate})` : ''}`);
        }
        lines.push(`   ${parts.join(' · ')}`);
        if (external.mrp) lines.push(`   MRP ${inr(external.mrp)}`);
        if (external.url) lines.push(`   📎 ${external.url}`);
        lines.push('');
    }

    const snapshots = result.snapshots || [];
    if (!snapshots.length) {
        lines.push('_No saved snapshots yet._');
        lines.push('_Run `/price <link-or-name>` regularly — every check stores a daily snapshot, so this section builds a trend over time._');
        lines.push('');
    } else {
        // Group by site, newest first, show a short timeline.
        const bySite = new Map();
        for (const s of snapshots) {
            if (!bySite.has(s.site)) bySite.set(s.site, []);
            bySite.get(s.site).push(s);
        }
        for (const [site, rows] of bySite) {
            lines.push(`${siteEmoji(site)} *${site} — saved snapshots*`);
            for (const r of rows.slice(0, 10)) {
                lines.push(`   • ${r.day} — ${inr(r.price)}${r.url ? ` · ${r.url}` : ''}`);
            }
            lines.push('');
        }
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
}

export async function handlePrice(sock, chatId, senderJid, args, ctx) {
    const mongoDb = ctx?.database?.mongoDb || null;
    const input = (args || []).join(' ').trim();

    if (!input) {
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '🏷️ *PRICE TRACKER* 🏷️\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Find the cheapest price for a product across Indian stores.\n\n' +
                '*Usage:*\n' +
                '• `/price <amazon/flipkart link>` — scan all stores + price history\n' +
                '• `/price <product name>` — e.g. `/price puma smashic sneakers`\n' +
                '• `/price history <link or name>` — saved snapshots over time\n\n' +
                '_Scans: Amazon · Flipkart · Myntra · Ajio · Snapdeal · Tata CLiQ_\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        });
        return;
    }

    const action = (args[0] || '').toLowerCase();
    if (action === 'history' || action === 'h') {
        const subInput = args.slice(1).join(' ').trim();
        if (!subInput) {
            await sock.sendMessage(chatId, {
                text: '❌ Usage: `/price history <amazon-or-flipkart-link-or-product-name>`',
            });
            return;
        }
        const loading = await sock.sendMessage(chatId, {
            text: '📈 _Fetching saved price history…_',
        });
        try {
            const asin = extractAmazonAsin(subInput);
            const fkUrl = extractFlipkartUrl(subInput);
            const fkPid = fkUrl ? await resolveFlipkartPid(fkUrl) : null;
            const idKey = asin ? `asin:${asin}` : fkPid ? `fk:${fkPid}` : null;
            const snapshots = await getPriceSnapshots(mongoDb, { input: subInput, asin, idKey });
            // Past prices (pricehistory.app) work immediately for store links,
            // even before Mongo snapshots accumulate.
            let external = null;
            try {
                if (asin) external = await fetchPriceHistory(asin);
                else if (fkUrl) external = await fetchPriceHistory(sanitizeFlipkartUrl(fkUrl));
            } catch (err) {
                logger.warn(`Price history external fetch failed: ${err.message}`);
            }
            const card = formatHistoryCard({ query: subInput, asin, idKey, snapshots, external });
            await sock.sendMessage(chatId, { text: card });
        } catch (err) {
            logger.error(`Price history failed: ${err.message}`);
            await sock.sendMessage(chatId, { text: `❌ Could not fetch history: ${err.message}` });
        } finally {
            if (loading?.key) await sock.sendMessage(chatId, { delete: loading.key }).catch(() => {});
        }
        return;
    }

    const loading = await sock.sendMessage(chatId, {
        text: '🔍 _Scanning Amazon · Flipkart · Myntra · Ajio · Snapdeal…_\n_⏳ This can take ~15–30s_',
    });

    try {
        const result = await trackProduct(input, { timeoutMs: config.PRICE_TRACKER_TIMEOUT_MS });
        if (mongoDb) {
            try {
                await savePriceSnapshots(mongoDb, {
                    input,
                    asin: result.asin,
                    idKey: result.idKey,
                    query: result.query,
                    offers: result.rawOffers,
                });
            } catch (err) {
                logger.warn(`Price snapshot save failed: ${err.message}`);
            }
        }
        const card = formatTrackCard(result);
        await sock.sendMessage(chatId, { text: card });
        logger.info(`🏷️ Price tracked "${input}" by ${senderJid} → ${result.offers.length} offers`);
    } catch (err) {
        logger.error(`Price tracker failed: ${err.message}`);
        await sock.sendMessage(chatId, {
            text:
                '❌ Price scan failed.\n' +
                `_${err.message}_\n\n` +
                '_Try again in a minute — retail sites rate-limit aggressively._',
        });
    } finally {
        if (loading?.key) await sock.sendMessage(chatId, { delete: loading.key }).catch(() => {});
    }
}
