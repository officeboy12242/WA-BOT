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
    productKey,
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
    return '🛒';
}

/** Build the main comparison card. */
function formatTrackCard(result) {
    const { query, amazon, history, offers, asin } = result;
    const lines = [];

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🏷️ *PRICE TRACKER* 🏷️');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`🛒 *${shortTitle(query, 80)}*`);
    if (amazon?.rating) lines.push(`⭐ ${amazon.rating}/5 · ${amazon.availability ? `_${amazon.availability}_` : ''}`.trim());
    lines.push('');

    if (!offers.length) {
        lines.push('😕 _No prices found right now._');
        lines.push('_Try a more specific product name, or paste an Amazon.in link._');
    } else {
        const maxOffers = Math.min(config?.PRICE_TRACKER_MAX_OFFERS || 8, 8);
        const best = offers[0];
        const bestIsAmazon = best.site === 'Amazon' && amazon;
        lines.push(`💰 *Best price: ${inr(best.price)}* — ${best.site} ${siteEmoji(best.site)}`);
        // Only compare against the tracked product when the best offer IS it —
        // a different-brand cheap lookalike must not claim Amazon's MRP savings.
        if (bestIsAmazon && amazon?.mrp && amazon.mrp > best.price) {
            const save = Math.round(((amazon.mrp - best.price) / amazon.mrp) * 100);
            lines.push(`   _MRP ${inr(amazon.mrp)} · save ${save}%_`);
        } else if (bestIsAmazon && amazon?.price && best.price === amazon.price && amazon.mrp) {
            lines.push(`   _MRP ${inr(amazon.mrp)}_`);
        } else if (amazon?.price && best.price < amazon.price) {
            const diff = Math.round(((amazon.price - best.price) / amazon.price) * 100);
            lines.push(`   _${diff}% below the tracked Amazon price (${inr(amazon.price)})_`);
        }
        lines.push('');

        lines.push('┌─ *ALL OFFERS (cheapest first)* ─');
        offers.slice(0, maxOffers).forEach((o, i) => {
            const tag = i === 0 ? '🔥 ' : '';
            const priceLine = `${tag}${i + 1}. ${inr(o.price)} · *${o.site}*`;
            lines.push(`│ ${priceLine}`);
            if (o.url) lines.push(`│    🔗 ${o.url}`);
        });
        lines.push('└────────────────────────────');
        lines.push('');
    }

    if (history) {
        lines.push('📈 *Amazon price history*');
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

    lines.push(`_Data: Amazon · Flipkart · Myntra · Ajio · Snapdeal · pricehistory.app_`);
    lines.push(`_Checked ${new Date().toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit' })} IST_`);
    if (asin) lines.push(`_ASIN ${asin} — re-check with the same link to build history_`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
}

/** Build the history card from stored snapshots. */
function formatHistoryCard(result) {
    const { query, asin } = result;
    const lines = [];
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📈 *PRICE HISTORY* 📈');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`🛒 *${shortTitle(query, 80)}*`);
    lines.push('');

    const snapshots = result.snapshots || [];
    if (!snapshots.length) {
        lines.push('_No saved price history yet._');
        lines.push('_Run `/price <link-or-name>` to start tracking — every check stores a daily snapshot._');
        lines.push('');
        if (asin) {
            lines.push('💡 For Amazon you can also see past prices on pricehistory.app:');
            lines.push(`   📊 https://www.pricehistory.app/p/ (search the ASIN)`);
        }
    } else {
        // Group by site, newest first, show a short timeline.
        const bySite = new Map();
        for (const s of snapshots) {
            if (!bySite.has(s.site)) bySite.set(s.site, []);
            bySite.get(s.site).push(s);
        }
        for (const [site, rows] of bySite) {
            lines.push(`${siteEmoji(site)} *${site}*`);
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
                '• `/price <amazon link>` — scan all stores + price history\n' +
                '• `/price <product name>` — e.g. `/price puma smashic sneakers`\n' +
                '• `/price history <link or name>` — saved snapshots over time\n\n' +
                '_Scans: Amazon · Flipkart · Myntra · Ajio · Snapdeal_\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        });
        return;
    }

    const action = (args[0] || '').toLowerCase();
    if (action === 'history' || action === 'h') {
        const subInput = args.slice(1).join(' ').trim();
        if (!subInput) {
            await sock.sendMessage(chatId, {
                text: '❌ Usage: `/price history <amazon-link-or-product-name>`',
            });
            return;
        }
        const loading = await sock.sendMessage(chatId, {
            text: '📈 _Fetching saved price history…_',
        });
        try {
            const asin = extractAmazonAsin(subInput);
            const snapshots = await getPriceSnapshots(mongoDb, { input: subInput, asin });
            const card = formatHistoryCard({ query: subInput, asin, snapshots });
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
