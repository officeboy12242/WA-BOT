/**
 * Telegram Sticker Service
 * Fetches sticker packs from Telegram via Bot API and converts to WhatsApp format.
 *
 * - Static WebP → resize + compress
 * - Animated TGS → render multiple Lottie frames → ffmpeg animated WebP
 * - Video stickers (MP4) → send directly as WhatsApp video sticker
 *
 * Supports abort via AbortController (user sends /tgstop).
 *
 * Requires TELEGRAM_BOT_TOKEN env var.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { execSync } from 'child_process';

const TG_API = 'https://api.telegram.org';
const STICKER_WEBP_MAX = 100 * 1024; // 100 KB — WhatsApp sticker limit
const ANIM_WEBP_MAX = 500 * 1024;    // 500 KB — WhatsApp animated sticker limit
const VIDEO_STICKER_MAX = 1 * 1024 * 1024; // 1 MB — WhatsApp video sticker limit
const DOWNLOAD_CONCURRENCY = 3;
const ANIM_FRAME_COUNT = 20; // Frames to render for animated stickers
const ANIM_FPS = 15;         // Target FPS for animated WebP

/* ─── Active imports (for /tgstop) ─── */
export const activeImports = new Map(); // chatId → AbortController

export function abortImport(chatId) {
    const ctrl = activeImports.get(chatId);
    if (ctrl) {
        ctrl.abort();
        activeImports.delete(chatId);
        return true;
    }
    return false;
}

export function isImportActive(chatId) {
    return activeImports.has(chatId);
}

class TelegramStickerService {
    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'whatsapp-bot-tg-stickers');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    get token() {
        return config.TELEGRAM_BOT_TOKEN;
    }

    get isConfigured() {
        return Boolean(this.token);
    }

    /** Parse pack name from URL or raw input. */
    parsePackInput(input) {
        if (!input || typeof input !== 'string') return null;
        const trimmed = input.trim();

        let m = trimmed.match(/t\.me\/addstickers\/([A-Za-z0-9_-]+)$/i);
        if (m) return m[1];

        m = trimmed.match(/tg:\/\/addstickers\?set=([A-Za-z0-9_-]+)/i);
        if (m) return m[1];

        if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
        return null;
    }

    /** Fetch sticker set metadata from Telegram Bot API. */
    async getStickerSet(packName) {
        if (!this.isConfigured) {
            throw new Error('Telegram Bot token not configured. Set TELEGRAM_BOT_TOKEN in .env');
        }

        const url = `${TG_API}/bot${this.token}/getStickerSet?name=${encodeURIComponent(packName)}`;
        const res = await axios.get(url, { timeout: 15000 });

        if (!res.data?.ok) {
            throw new Error(`Telegram API: ${res.data?.description || 'Unknown error'}`);
        }
        return res.data.result;
    }

    /** Get the file download URL for a sticker by file_id. */
    async getFileUrl(fileId) {
        const url = `${TG_API}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const res = await axios.get(url, { timeout: 10000 });

        if (!res.data?.ok) {
            throw new Error(`getFile failed: ${res.data?.description || 'unknown'}`);
        }

        const filePath = res.data.result.file_path;
        return `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    }

    /** Download a sticker file to a temp path. */
    async downloadSticker(sticker, index) {
        const fileId = sticker.file_id;
        const isAnimated = sticker.is_animated || false;
        const isVideo = sticker.is_video || false;
        const emoji = sticker.emoji || '❓';
        const format = isVideo ? 'mp4' : isAnimated ? 'tgs' : 'webp';

        const fileUrl = await this.getFileUrl(fileId);
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        const buffer = Buffer.from(res.data);
        const ext = format === 'mp4' ? '.mp4' : format === 'tgs' ? '.tgs' : '.webp';
        const tempPath = path.join(this.tempDir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
        fs.writeFileSync(tempPath, buffer);

        return { tempPath, buffer, size: buffer.length, isAnimated, isVideo, emoji, format, index };
    }

        /* ──────────────────────────────────────────────
     *  SVG-based Lottie renderer (via sharp/librsvg)
     * ────────────────────────────────────────────── */

    /** Render a Lottie JSON to PNG buffer for a given frame using SVG→sharp. */
    async _lottieFrameToPng(lottie, frame) {
        const sharp = (await import('sharp')).default;
        const w = lottie.w || 512;
        const h = lottie.h || 512;
        const svg = this._lottieToSvg(lottie, frame, w, h);
        return sharp(Buffer.from(svg)).png().toBuffer();
    }

    /** Convert Lottie JSON to SVG string for a single frame. */
    _lottieToSvg(lottie, frame, w, h) {
        const layers = lottie.layers || [];
        const assets = lottie.assets || [];
        const assetMap = new Map();
        for (const a of assets) { if (a.id) assetMap.set(a.id, a); }
        const sorted = [...layers].sort((a, b) => (a.zi ?? 0) - (b.zi ?? 0));
        let gradDefs = '';
        let inner = '';
        for (const layer of sorted) {
            const result = this._svgLayer(layer, frame, w, h, assetMap);
            gradDefs += result.defs;
            inner += result.svg;
        }
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${gradDefs}</defs>${inner}</svg>`;
    }

    _svgLayer(layer, frame, w, h, assetMap) {
        const result = { defs: '', svg: '' };
        if (!layer) return result;
        const ip = layer.ip ?? 0;
        const op = layer.op ?? Infinity;
        if (frame < ip || frame > op) return result;
        const opacity = this._resolveProp(layer.ks?.o, frame) ?? 100;
        if (opacity <= 0) return result;

        // Precomp
        if (layer.ty === 0) {
            const comp = assetMap.get(layer.refId);
            if (!comp?.layers) return result;
            let inner = '';
            for (const sub of comp.layers) {
                const r = this._svgLayer(sub, frame, w, h, assetMap);
                result.defs += r.defs;
                inner += r.svg;
            }
            const tr = this._svgTransform(layer.ks?.tr, frame, w, h);
            const opA = opacity < 100 ? ` opacity="${(opacity / 100).toFixed(3)}"` : '';
            result.svg = `<g${tr}${opA}>${inner}</g>`;
            return result;
        }

        if (layer.ty === 1 || layer.ty === 2 || layer.ty === 3) return result; // solid/image/null

        if (layer.ty === 4) {
            const tr = this._svgTransform(layer.ks?.tr, frame, w, h);
            const opA = opacity < 100 ? ` opacity="${(opacity / 100).toFixed(3)}"` : '';
            let shapes = '';
            for (const s of (layer.shapes || [])) {
                const r = this._svgShape(s, frame, assetMap, w, h);
                result.defs += r.defs;
                shapes += r.svg;
            }
            result.svg = `<g${tr}${opA}>${shapes}</g>`;
            return result;
        }
        return result;
    }

    _svgShape(shape, frame, assetMap, w, h) {
        const result = { defs: '', svg: '' };
        if (!shape) return result;
        if (shape.ty === 'gr') {
            const items = shape.it || [];
            let trStr = '';
            const pathDs = [];
            let fillStr = '', strokeStr = '';
            for (const item of items) {
                if (item.ty === 'tr') {
                    trStr = this._svgTransform(item, frame, 0, 0);
                } else if (item.ty === 'sh' || item.ty === 'el' || item.ty === 'rc') {
                    pathDs.push(this._svgPathD(item, frame));
                } else if (item.ty === 'fl') {
                    fillStr += this._svgFill(item, frame, w, h);
                } else if (item.ty === 'st') {
                    strokeStr += this._svgStroke(item, frame, w, h);
                } else if (item.ty === 'gf') {
                    const g = this._svgGradFill(item, frame, w, h);
                    result.defs += g.defs;
                    fillStr += g.attr;
                }
            }
            const d = pathDs.join(' ');
            if (!d) return result;
            result.svg = `<g${trStr}><path d="${d}"${fillStr}${strokeStr}/></g>`;
            return result;
        }
        return result;
    }

    _svgPathD(shape, frame) {
        if (shape.ty === 'sh') {
            const pd = shape.ks;
            const verts = pd?.k?.v || pd?.v || [];
            const inn = pd?.k?.i || pd?.i || [];
            const out = pd?.k?.o || pd?.o || [];
            const closed = pd?.k?.c ?? pd?.c ?? false;
            if (!verts.length) return '';
            let d = `M${verts[0][0]} ${verts[0][1]}`;
            for (let i = 1; i < verts.length; i++) {
                const c1x = verts[i-1][0] + (out[i-1]?.[0] || 0);
                const c1y = verts[i-1][1] + (out[i-1]?.[1] || 0);
                const c2x = verts[i][0] + (inn[i]?.[0] || 0);
                const c2y = verts[i][1] + (inn[i]?.[1] || 0);
                d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${verts[i][0]} ${verts[i][1]}`;
            }
            if (closed) d += ' Z';
            return d;
        }
        if (shape.ty === 'el') {
            const pos = this._resolveProp(shape.p, frame) ?? [0, 0];
            const size = this._resolveProp(shape.s, frame) ?? [0, 0];
            const rx = Math.abs((Array.isArray(size) ? size[0] : 0) / 2);
            const ry = Math.abs((Array.isArray(size) ? size[1] : 0) / 2);
            const cx = Array.isArray(pos) ? pos[0] : 0;
            const cy = Array.isArray(pos) ? pos[1] : 0;
            // Approximate ellipse with 4 bezier curves (kappa constant)
            const k = 0.5522847498;
            const kx = rx * k, ky = ry * k;
            return `M${cx} ${cy - ry} C${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy} C${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry} C${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy} C${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry} Z`;
        }
        if (shape.ty === 'rc') {
            const pos = this._resolveProp(shape.p, frame) ?? [0, 0];
            const size = this._resolveProp(shape.s, frame) ?? [100, 100];
            const sw = Array.isArray(size) ? size[0] : 100;
            const sh = Array.isArray(size) ? size[1] : 100;
            const r = Math.min(this._resolveProp(shape.r, frame) ?? 0, sw / 2, sh / 2);
            const cx = (Array.isArray(pos) ? pos[0] : 0) - sw / 2;
            const cy = (Array.isArray(pos) ? pos[1] : 0) - sh / 2;
            if (r > 0) return `M${cx + r} ${cy} L${cx + sw - r} ${cy} Q${cx + sw} ${cy} ${cx + sw} ${cy + r} L${cx + sw} ${cy + sh - r} Q${cx + sw} ${cy + sh} ${cx + sw - r} ${cy + sh} L${cx + r} ${cy + sh} Q${cx} ${cy + sh} ${cx} ${cy + sh - r} L${cx} ${cy + r} Q${cx} ${cy} ${cx + r} ${cy} Z`;
            return `M${cx} ${cy} L${cx + sw} ${cy} L${cx + sw} ${cy + sh} L${cx} ${cy + sh} Z`;
        }
        return '';
    }

    _svgFill(shape, frame) {
        const c = shape.c?.k || [0,0,0,1];
        const a = this._resolveProp(shape.o, frame) ?? 100;
        const alpha = a / 100;
        const color = this._svgColor(c);
        if (alpha < 1) return ` fill="${color}" fill-opacity="${alpha.toFixed(3)}"`;
        return ` fill="${color}"`;
    }

    _svgStroke(shape, frame) {
        const c = shape.c?.k || [0,0,0,1];
        const a = this._resolveProp(shape.o, frame) ?? 100;
        const sw = this._resolveProp(shape.w, frame) ?? 1;
        const alpha = a / 100;
        const color = this._svgColor(c);
        let attrs = ` stroke="${color}" stroke-width="${sw}" fill="none"`;
        if (alpha < 1) attrs += ` stroke-opacity="${alpha.toFixed(3)}"`;
        return attrs;
    }

    _svgGradFill(shape, frame) {
        const stops = shape.g?.k || [];
        const p = shape.g?.p || 2;
        const gradId = `g${Math.random().toString(36).slice(2, 8)}`;
        if (p >= 2 && stops.length >= p * 4) {
            const sx = shape.s?.k ?? 0;
            const sy = shape.e?.k ?? 100;
            let defs = `<linearGradient id="${gradId}" x1="${sx}" y1="0" x2="${sy}" y2="0" gradientUnits="userSpaceOnUse">`;
            for (let i = 0; i < p; i++) {
                const off = (i / (p - 1)).toFixed(3);
                const r = Math.round((stops[i*4] || 0) * 255);
                const g = Math.round((stops[i*4+1] || 0) * 255);
                const b = Math.round((stops[i*4+2] || 0) * 255);
                const a = stops[i*4+3] ?? 1;
                defs += `<stop offset="${off}" stop-color="rgb(${r},${g},${b})" stop-opacity="${a.toFixed(3)}"/>`;
            }
            defs += '</linearGradient>';
            return { defs, attr: ` fill="url(#${gradId})"` };
        }
        return { defs: '', attr: ' fill="black"' };
    }

    _svgColor(c) {
        if (!c) return '#000';
        const r = Math.round((c[0] || 0) * 255);
        const g = Math.round((c[1] || 0) * 255);
        const b = Math.round((c[2] || 0) * 255);
        return `rgb(${r},${g},${b})`;
    }

    _svgTransform(tr, frame, w, h) {
        if (!tr) return '';
        const pos = this._resolveProp(tr.p, frame);
        const anchor = this._resolveProp(tr.a, frame);
        const scale = this._resolveProp(tr.s, frame);
        const rotation = this._resolveProp(tr.r, frame) ?? 0;
        const px = Array.isArray(pos) ? pos[0] : w / 2;
        const py = Array.isArray(pos) ? pos[1] : h / 2;
        const ax = Array.isArray(anchor) ? anchor[0] : 0;
        const ay = Array.isArray(anchor) ? anchor[1] : 0;
        let sx = 1, sy = 1;
        if (Array.isArray(scale)) { sx = scale[0] / 100; sy = scale[1] / 100; }
        else if (typeof scale === 'number') { sx = sy = scale / 100; }
        const parts = [`translate(${px},${py})`];
        if (rotation) parts.push(`rotate(${rotation})`);
        if (sx !== 1 || sy !== 1) parts.push(`scale(${sx.toFixed(4)},${sy.toFixed(4)})`);
        if (ax || ay) parts.push(`translate(${-ax},${-ay})`);
        return ` transform="${parts.join(' ')}"`;
    }

    _resolveProp(prop, frame) {
        if (!prop) return undefined;
        if (prop.k !== undefined && !Array.isArray(prop.k)) return prop.k;
        if (Array.isArray(prop.k) && prop.k.length <= 4 && typeof prop.k[0] !== 'object') return prop.k;
        if (Array.isArray(prop.k) && prop.k.length > 0 && prop.k[0]?.t !== undefined) {
            return this._interpolateKeyframes(prop.k, frame);
        }
        return prop.k;
    }

    _interpolateKeyframes(keyframes, frame) {
        if (!keyframes?.length) return undefined;
        let prev = keyframes[0], next = keyframes[keyframes.length - 1];
        for (let i = 0; i < keyframes.length; i++) {
            if (keyframes[i].t <= frame) prev = keyframes[i];
            if (keyframes[i].t > frame && next === keyframes[keyframes.length - 1]) { next = keyframes[i]; break; }
        }
        if (prev.t === next.t || next.t > frame) return prev.s ?? prev.e ?? prev.k;
        const rawT = (frame - prev.t) / (next.t - prev.t);
        let t = rawT;
        if (prev.o && prev.i) t = this._bezierInterpolate(rawT, prev.o, prev.i);
        else if (prev.o) t = this._bezierInterpolate(rawT, prev.o, [1 - prev.o[0], 1 - prev.o[1]]);
        else if (prev.i) t = this._bezierInterpolate(rawT, [1 - prev.i[0], 1 - prev.i[1]], prev.i);
        const from = prev.s ?? prev.e ?? prev.k;
        const to = next.s ?? next.e ?? next.k;
        if (Array.isArray(from) && Array.isArray(to)) return from.map((v, i) => v + ((to[i] ?? v) - v) * t);
        if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * t;
        return from;
    }

    _bezierInterpolate(t, outT, inT) {
        const cx = 3 * (outT[0] || 0);
        const bx = 3 * ((inT?.[0] ?? 1) - outT[0]) - cx;
        const ax = 1 - cx - bx;
        const cy = 3 * (outT[1] || 0);
        const by = 3 * ((inT?.[1] ?? 1) - outT[1]) - cy;
        const ay = 1 - cy - by;
        let x = t;
        for (let i = 0; i < 8; i++) {
            const cur = ((ax * x + bx) * x + cx) * x - t;
            if (Math.abs(cur) < 1e-6) break;
            const dx = (3 * ax * x + 2 * bx) * x + cx;
            if (Math.abs(dx) < 1e-6) break;
            x -= cur / dx;
        }
        x = Math.max(0, Math.min(1, x));
        return ((ay * x + by) * x + cy) * x;
    }

    /* ──────────────────────────────────────────────
     *  TGS conversion methods (SVG-based)
     * ────────────────────────────────────────────── */

    /** Create animated WebP from TGS using SVG→sharp frame rendering + ffmpeg. */
    async tgsToAnimatedWebp(tgsBuffer) {
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);
        const width = lottie.w || 512;
        const height = lottie.h || 512;
        const totalFrames = lottie.op || lottie.fr || 30;
        const frameRate = lottie.fr || 30;
        const frameDir = path.join(this.tempDir, `frames_${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(frameDir, { recursive: true });
        try {
            const frameStep = Math.max(1, Math.floor(totalFrames / ANIM_FRAME_COUNT));
            const framesToRender = [];
            for (let f = 0; f < totalFrames; f += frameStep) {
                if (framesToRender.length >= ANIM_FRAME_COUNT) break;
                framesToRender.push(f);
            }
            for (let i = 0; i < framesToRender.length; i++) {
                const pngBuf = await this._lottieFrameToPng(lottie, framesToRender[i]);
                fs.writeFileSync(path.join(frameDir, `frame_${String(i + 1).padStart(4, '0')}.png`), pngBuf);
            }
            const outputPath = path.join(this.tempDir, `anim_${crypto.randomBytes(4).toString('hex')}.webp`);
            const fps = Math.min(ANIM_FPS, frameRate);
            execSync(
                `ffmpeg -y -framerate ${fps} -i "${path.join(frameDir, 'frame_%04d.png')}" `
                + `-vf "scale=${width}:${height}" `
                + `-vcodec libwebp -lossless 0 -q:v 60 -loop 0 -preset drawing `
                + `-an -vsync 0 "${outputPath}" 2>&1`,
                { timeout: 30000, stdio: 'pipe' }
            );
            const webpBuffer = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath);
            return webpBuffer;
        } finally {
            try { for (const f of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, f)); fs.rmdirSync(frameDir); } catch {}
        }
    }

    /** Create MP4 video sticker from TGS using SVG→sharp frame rendering + ffmpeg. */
    async tgsToMp4Video(tgsBuffer) {
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);
        const width = lottie.w || 512;
        const height = lottie.h || 512;
        const totalFrames = lottie.op || lottie.fr || 30;
        const frameRate = lottie.fr || 30;
        const frameDir = path.join(this.tempDir, `frames_${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(frameDir, { recursive: true });
        try {
            const frameStep = Math.max(1, Math.floor(totalFrames / ANIM_FRAME_COUNT));
            const framesToRender = [];
            for (let f = 0; f < totalFrames; f += frameStep) {
                if (framesToRender.length >= ANIM_FRAME_COUNT) break;
                framesToRender.push(f);
            }
            for (let i = 0; i < framesToRender.length; i++) {
                const pngBuf = await this._lottieFrameToPng(lottie, framesToRender[i]);
                fs.writeFileSync(path.join(frameDir, `frame_${String(i + 1).padStart(4, '0')}.png`), pngBuf);
            }
            const outputPath = path.join(this.tempDir, `anim_${crypto.randomBytes(4).toString('hex')}.mp4`);
            const fps = Math.min(ANIM_FPS, frameRate);
            execSync(
                `ffmpeg -y -framerate ${fps} -i "${path.join(frameDir, 'frame_%04d.png')}" `
                + `-vf "scale=${width}:${height},format=yuv420p" `
                + `-c:v libx264 -preset fast -crf 26 -pix_fmt yuv420p `
                + `-an -movflags +faststart -t 6 "${outputPath}" 2>&1`,
                { timeout: 30000, stdio: 'pipe' }
            );
            const mp4Buffer = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath);
            return mp4Buffer;
        } finally {
            try { for (const f of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, f)); fs.rmdirSync(frameDir); } catch {}
        }
    }

    /** Fallback: extract just the first frame as static WebP. */
    async tgsToStaticFrame(tgsBuffer) {
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);
        return this._lottieFrameToPng(lottie, 0);
    }

    /* ──────────────────────────────────────────────
     *  Sticker conversion pipeline
     * ────────────────────────────────────────────── */
/* ──────────────────────────────────────────────
     *  Sticker conversion pipeline
     * ────────────────────────────────────────────── */

    isStaticWebp(buffer) {
        if (!buffer || buffer.length < 12) return false;
        return buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';
    }

    /**
     * Convert a sticker buffer to WhatsApp-compatible format.
     * Returns { buffer, type } where type is 'sticker' or 'video'.
     */
    async convertToWhatsAppSticker(buffer, emoji, format) {
        const sharp = (await import('sharp')).default;

        // Video stickers — send as MP4 directly
        if (format === 'mp4') {
            if (buffer.length <= VIDEO_STICKER_MAX) {
                return { buffer, type: 'video' };
            }
            // Try to compress with ffmpeg
            try {
                const tmpIn = path.join(this.tempDir, `vid_${crypto.randomBytes(4).toString('hex')}.mp4`);
                const tmpOut = path.join(this.tempDir, `vid_${crypto.randomBytes(4).toString('hex')}.mp4`);
                fs.writeFileSync(tmpIn, buffer);
                execSync(
                    `ffmpeg -y -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" ` +
                    `-c:v libx264 -preset fast -crf 28 -an -t 6 "${tmpOut}" 2>&1`,
                    { timeout: 20000, stdio: 'pipe' }
                );
                const compressed = fs.readFileSync(tmpOut);
                this._cleanup(tmpIn);
                this._cleanup(tmpOut);
                if (compressed.length <= VIDEO_STICKER_MAX) {
                    return { buffer: compressed, type: 'video' };
                }
            } catch {}
            // Fallback: send anyway, WhatsApp may accept slightly over limit
            return { buffer, type: 'video' };
        }

        // Animated TGS — try animated WebP first (standard WhatsApp format), then MP4, then static
        if (format === 'tgs') {
            // 1st: Try animated WebP (standard animated sticker format with ANIM chunk)
            try {
                const animWebp = await this.tgsToAnimatedWebp(buffer);
                if (animWebp && animWebp.length > 0 && animWebp.length <= ANIM_WEBP_MAX) {
                    const hasAnim = animWebp.includes(Buffer.from('ANIM'));
                    logger.info(`TGS → animated WebP: ${animWebp.length} bytes, ANIM: ${hasAnim}`);
                    if (hasAnim) {
                        return { buffer: animWebp, type: 'sticker', isAnimated: true };
                    }
                    logger.info('Animated WebP missing ANIM marker, trying MP4...');
                }
            } catch (err) {
                logger.warn(`TGS → animated WebP failed: ${err.message}`);
            }

            // 2nd: Try MP4 video sticker
            try {
                const mp4Buffer = await this.tgsToMp4Video(buffer);
                if (mp4Buffer && mp4Buffer.length > 0 && mp4Buffer.length <= VIDEO_STICKER_MAX) {
                    logger.info(`TGS → MP4 video sticker: ${mp4Buffer.length} bytes`);
                    return { buffer: mp4Buffer, type: 'video' };
                }
            } catch (err) {
                logger.warn(`TGS → MP4 failed: ${err.message}`);
            }

            // 3rd: Fallback to static first frame
            try {
                logger.info('TGS → static frame fallback');
                const pngBuffer = await this.tgsToStaticFrame(buffer);
                const fallback = await sharp(pngBuffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80, alphaQuality: 100 })
                    .toBuffer();
                return { buffer: fallback, type: 'sticker' };
            } catch (e2) {
                throw new Error(`Animated sticker conversion failed: ${e2.message}`);
            }
        }

        // Static WebP — compress if needed
        if (buffer.length <= STICKER_WEBP_MAX && this.isStaticWebp(buffer)) {
            return { buffer, type: 'sticker' };
        }

        const converted = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80, alphaQuality: 100 })
            .toBuffer();

        if (converted.length <= STICKER_WEBP_MAX) {
            return { buffer: converted, type: 'sticker' };
        }

        const smaller = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 50, alphaQuality: 80 })
            .toBuffer();

        return { buffer: smaller, type: 'sticker' };
    }

    /**
     * Fetch and convert an entire sticker pack.
     * @param {string} packName
     * @param {Function} onProgress - (convertedCount, failedCount, phase)
     * @param {AbortSignal} [signal] - AbortSignal to cancel
     * @returns {{ pack, stickers, errors }}
     */
    async fetchAndConvertPack(packName, onProgress, signal) {
        const report = (converted, failed, phase) => {
            try { onProgress?.(converted, failed, phase); } catch {}
        };

        const pack = await this.getStickerSet(packName);
        const totalStickers = pack.stickers?.length || 0;

        if (!totalStickers) {
            return { pack, stickers: [], errors: ['Empty sticker pack'] };
        }

        const toProcess = pack.stickers;
        const results = [];
        const errors = [];
        let convertedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < toProcess.length; i += DOWNLOAD_CONCURRENCY) {
            // Check abort before each batch
            if (signal?.aborted) {
                errors.push('Import cancelled by user');
                break;
            }

            const batch = toProcess.slice(i, i + DOWNLOAD_CONCURRENCY);

            const downloads = await Promise.allSettled(
                batch.map((sticker, j) => this.downloadSticker(sticker, i + j))
            );

            for (let j = 0; j < downloads.length; j++) {
                // Check abort before each conversion
                if (signal?.aborted) {
                    errors.push('Import cancelled by user');
                    break;
                }

                const result = downloads[j];
                const sticker = batch[j];

                if (result.status === 'rejected') {
                    failedCount++;
                    errors.push(`Sticker ${i + j + 1}: ${result.reason?.message || 'download failed'}`);
                    report(convertedCount, failedCount, 'convert');
                    continue;
                }

                const dl = result.value;

                try {
                    const { buffer: waBuffer, type, isAnimated } = await this.convertToWhatsAppSticker(dl.buffer, dl.emoji, dl.format);
                    results.push({
                        buffer: waBuffer,
                        emoji: dl.emoji,
                        index: dl.index,
                        type, // 'sticker' or 'video'
                        isAnimated: isAnimated || false,
                    });
                    convertedCount++;
                    report(convertedCount, failedCount, 'convert');
                } catch (err) {
                    failedCount++;
                    errors.push(`Sticker ${i + j + 1} (${dl.emoji}): ${err.message}`);
                    report(convertedCount, failedCount, 'convert');
                } finally {
                    this._cleanup(dl.tempPath);
                }
            }

            if (signal?.aborted) break;
        }

        report(convertedCount, failedCount, 'done');
        return { pack, stickers: results, errors };
    }

    _cleanup(filePath) {
        try { fs.unlinkSync(filePath); } catch {}
    }

    cleanup() {
        try {
            const files = fs.readdirSync(this.tempDir);
            for (const f of files) {
                fs.unlinkSync(path.join(this.tempDir, f));
            }
        } catch {}
    }
}

export const telegramStickerService = new TelegramStickerService();
export default TelegramStickerService;
