/**
 * Self-check: FSL short-link /d/ redirect diagnostics.
 *
 * 1. Dumps the most recent short_links docs (labelled).
 * 2. Finds codes stored for FSL (cdn.cocktail.beer / fsl / lenin.buzz) links.
 * 3. Simulates the /d/ route's normalization for each stored long_url —
 *    exactly what adminPanel does before writeHead(302).
 *
 * Run: node scripts/check-fsl-shortlink.js [code]
 */
import dotenv from 'dotenv';

dotenv.config();

const BASE = 'https://renewed-evelina-script-kiddie-jkb-f623f42a.koyeb.app';

const { connectMongo, closeMongo } = await import('../src/db/mongo.js');
const { config } = await import('../src/config/config.js');
const { shortLinkService } = await import('../src/services/ShortLinkService.js');

const db = await connectMongo({ uri: config.MONGODB_URI, dbName: config.MONGODB_DB_NAME });
await shortLinkService.init(db);

const col = db.collection('short_links');

// 1. latest docs
const latest = await col.find({}).sort({ created_at: -1 }).limit(10).toArray();
console.log(`\n=== latest ${latest.length} short_links docs ===`);
for (const d of latest) {
    console.log(`- ${d.code}  exp=${new Date(d.expires_at).toISOString()}  url=${String(d.long_url).slice(0, 110)}`);
}

// 2. FSL-ish docs
const fslDocs = await col
    .find({ long_url: { $regex: 'cocktail\\.beer|fsl|lenin\\.buzz', $options: 'i' } })
    .sort({ created_at: -1 })
    .limit(10)
    .toArray();
console.log(`\n=== FSL-ish docs: ${fslDocs.length} ===`);
for (const d of fslDocs) {
    console.log(`- ${d.code}  exp=${new Date(d.expires_at).toISOString()}`);
    console.log(`    raw: ${JSON.stringify(d.long_url)}`);
}

// 3. pick a code to simulate: CLI arg, else first FSL doc, else first recent
const code = process.argv[2] || fslDocs[0]?.code || latest[0]?.code;
const doc = code ? await col.findOne({ code }) : null;
if (!doc) {
    console.log(`\n(no doc found for code '${code}')`);
} else {
    console.log(`\n=== simulate /d/${code} ===`);
    console.log(`raw long_url chars: ${[...String(doc.long_url)].filter((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126).map((c) => 'U+' + c.charCodeAt(0).toString(16)).join(',') || 'none'}`);

    // exact adminPanel normalization
    let safe = null;
    try {
        safe = new URL(String(doc.long_url).trim().replace(/[\u0000-\u001f\u007f]/g, '')).href;
    } catch {
        try { safe = new URL(encodeURI(String(doc.long_url).trim())).href; } catch { safe = null; }
    }
    console.log(`normalized ok: ${safe ? 'YES → ' + safe : 'NO (would meta-refresh)'}`);

    // live route check
    const res = await fetch(`${BASE}/d/${code}`, { redirect: 'manual' });
    const body = await res.text();
    console.log(`live GET /d/${code} → ${res.status} location=${res.headers.get('location') || '(none)'} body="${body.slice(0, 80)}"`);
}

await closeMongo();
