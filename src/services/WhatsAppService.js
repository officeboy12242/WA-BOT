/**
 * WhatsApp Service
 * Handles WhatsApp connection and event management
 */

import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger.js';
import { useDatabaseAuthState } from '../utils/databaseAuthState.js';
import { extractInstagramUrl } from '../utils/instagramUrl.js';
import { getMessageSenderJid, getTextForUrlScan, getTextFromWAMessage } from '../utils/waMessage.js';
import { resolveChannelSourceEntries } from '../utils/channelResolve.js';
import { extractStickerFromMessage, isNewsletterChat } from '../utils/stickerExtract.js';


/** Non-group chats where auto Instagram download is allowed (includes @lid privacy chats). */
function shouldAutoDetectInstaLink(chatId) {
    if (!chatId || typeof chatId !== 'string') {
        return false;
    }
    if (chatId.endsWith('@g.us')) {
        return false;
    }
    if (chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) {
        return false;
    }
    if (chatId.includes('newsletter')) {
        return false;
    }
    return true;
}

class WhatsAppService {
    constructor(
        commandController,
        stickerForwarder = null,
        authDatabase,
        groupManager = null,
        stickerSourceChannelEntries = [],
        channelStickerPoller = null,
        userManager = null,
        adminPanel = null
    ) {
        this.sock = null;
        this.isReady = false;
        this.commandController = commandController;
        this.stickerForwarder = stickerForwarder;
        this.authDatabase = authDatabase;
        this.groupManager = groupManager;
        this.stickerSourceChannelEntries = stickerSourceChannelEntries;
        this.channelStickerPoller = channelStickerPoller;
        this.userManager = userManager;
        this.adminPanel = adminPanel;
        
        // Message deduplication to prevent double processing
        this._processedMessages = new Set();
        this._messageCleanupInterval = null;
        
        // Give admin panel access to auth database for clearing
        if (this.adminPanel && this.authDatabase) {
            this.adminPanel.setAuthDatabase(this.authDatabase);
        }
    }
    
    /**
     * Check if message was already processed (prevents duplicate execution)
     */
    _isMessageProcessed(messageId) {
        if (!messageId) return false;
        if (this._processedMessages.has(messageId)) {
            return true;
        }
        this._processedMessages.add(messageId);
        return false;
    }
    
    /**
     * Start cleanup interval to prevent memory leak from stored message IDs
     */
    _startMessageCleanup() {
        if (this._messageCleanupInterval) return;
        
        // Clear old message IDs every 10 minutes
        this._messageCleanupInterval = setInterval(() => {
            if (this._processedMessages.size > 5000) {
                // Keep only the last 1000 messages
                const arr = [...this._processedMessages];
                this._processedMessages = new Set(arr.slice(-1000));
                logger.debug(`Message dedup cache trimmed: ${arr.length} → ${this._processedMessages.size}`);
            }
        }, 10 * 60 * 1000);
    }

    async connect() {
        // Use database auth instead of file-based auth
        const { state, saveCreds } = await useDatabaseAuthState(this.authDatabase);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }), // Reduce Baileys logging
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            generateHighQualityLinkPreview: true,
        });

        this.setupEventHandlers(saveCreds);
        
        return this.sock;
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info('📱 Scan this QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });
                
                // Update admin panel with QR code
                if (this.adminPanel) {
                    this.adminPanel.updateQR(qr, qr);
                }
            }

            if (connection === 'close') {
                this.isReady = false;
                
                // Update admin panel
                if (this.adminPanel) {
                    this.adminPanel.setDisconnected();
                }
                
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

                logger.info('Connection closed. Reconnecting: ' + shouldReconnect);

                if (shouldReconnect) {
                    setTimeout(async () => {
                        try {
                            await this.connect();
                        } catch (error) {
                            logger.error('Reconnection error:', error.message);
                        }
                    }, 3000); // Wait 3 seconds before reconnecting
                }
            } else if (connection === 'open') {
                logger.info('✅ Connected to WhatsApp!');
                this.isReady = true;
                this._startMessageCleanup();
                
                // Update admin panel with connected status
                if (this.adminPanel) {
                    const phoneNumber = this.sock?.user?.id?.split(':')[0] || 'Unknown';
                    this.adminPanel.setConnected(phoneNumber);
                }
                
                // Log available chats to help user find chat ID
                try {
                    const chats = await this.sock.groupFetchAllParticipating();
                    logger.info('\n📋 Available Groups:');
                    Object.values(chats).forEach((chat) => {
                        logger.info(`  - ${chat.subject}: ${chat.id}`);
                    });
                    await this.resolveStickerSourceChannels();
                } catch (err) {
                    logger.error('Error fetching groups:', err.message);
                }
            }
        });

        this.sock.ev.on('creds.update', () => {
            void saveCreds();
        });

        this.sock.ev.on('group-participants.update', (update) => {
            void this.commandController
                .handleGroupParticipantsUpdate(this.sock, update)
                .catch((err) => {
                    logger.error('Welcome message error:', err?.message || err);
                });
        });

        this.sock.ev.on('messages.update', (updates) => {
            if (!this.stickerForwarder) return;
            
            for (const update of updates) {
                const chatId = update.key?.remoteJid;
                const messageId = update.key?.id;
                
                if (!isNewsletterChat(chatId) || !update.update?.message) continue;
                if (!extractStickerFromMessage(update.update.message)) continue;
                if (!this.stickerForwarder.shouldForwardFrom(chatId)) continue;
                if (this.channelStickerPoller?.isSeen(chatId, messageId)) continue;
                
                this.channelStickerPoller?.rememberId(chatId, messageId);
                void this.stickerForwarder
                    .forwardSticker(this.sock, { key: update.key, message: update.update.message }, chatId)
                    .catch(() => {});
            }
        });

        // Handle each message concurrently so one slow command does not block others.
        this.sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type && type !== 'notify' && type !== 'append') {
                return;
            }
            for (const msg of messages) {
                void this.processIncomingMessage(msg).catch((err) => {
                    logger.error('Message handling error:', err?.message || err);
                });
            }
        });
    }

    async resolveStickerSourceChannels() {
        if (!this.stickerForwarder) {
            return;
        }

        const envEntries = this.stickerSourceChannelEntries;
        const dbChannels = this.groupManager ? await this.groupManager.getStickerChannelJids() : [];
        
        const allJids = new Set();
        const nameByJid = new Map();

        const { jids: envJids, resolved } = await resolveChannelSourceEntries(this.sock, envEntries);
        for (const row of resolved) {
            allJids.add(row.jid);
            nameByJid.set(row.jid, row.name);
        }

        for (const jid of dbChannels) {
            allJids.add(jid);
        }

        const jids = [...allJids];
        
        if (!jids.length) {
            logger.info('📢 No sticker channels configured (use /addchannel or .env)');
            if (this.channelStickerPoller) {
                this.channelStickerPoller.setChannels([]);
                this.channelStickerPoller.start(this.sock);
            }
            return;
        }

        this.stickerForwarder.setSourceChannels(jids, nameByJid);

        for (const jid of jids) {
            if (typeof this.sock.subscribeNewsletterUpdates === 'function') {
                try {
                    await this.sock.subscribeNewsletterUpdates(jid);
                } catch {}
            }
        }
        
        logger.info(`📡 Channel sticker forwarding active (${jids.length} channel(s))`);

        if (this.channelStickerPoller) {
            this.channelStickerPoller.setChannels(jids);
            this.channelStickerPoller.start(this.sock);
        }
    }

    async processIncomingMessage(msg) {
        if (!msg?.message) {
            return;
        }

        const chatId = msg.key.remoteJid;
        const messageId = msg.key?.id;
        if (!chatId) {
            return;
        }

        // Deduplication: skip if this message was already processed
        if (this._isMessageProcessed(messageId)) {
            return;
        }

        const isChannel = isNewsletterChat(chatId);
        const stickerPayload = extractStickerFromMessage(msg.message);

        if (stickerPayload && this.stickerForwarder) {
            const allowChannelSticker = isChannel && this.stickerForwarder.shouldForwardFrom(chatId);
            const allowGroupSticker = !msg.key.fromMe && !isChannel;

            if (allowChannelSticker) {
                if (this.channelStickerPoller?.isSeen(chatId, messageId)) {
                    return;
                }
                
                const hasKey = stickerPayload.mediaKey && 
                    (Buffer.isBuffer(stickerPayload.mediaKey) ? stickerPayload.mediaKey.length > 0 : 
                     stickerPayload.mediaKey instanceof Uint8Array ? stickerPayload.mediaKey.length > 0 : true);
                
                if (!hasKey) {
                    this.channelStickerPoller?.rememberId(chatId, messageId);
                    void this.stickerForwarder
                        .forwardSticker(this.sock, msg, chatId)
                        .catch((err) => {
                            logger.warn(`Channel sticker failed: ${err?.message || err}`);
                        });
                    return;
                }
                
                this.channelStickerPoller?.rememberId(chatId, messageId);
                logger.info(`📡 Channel sticker received: ${chatId} (${messageId})`);
                void this.stickerForwarder
                    .forwardSticker(this.sock, msg, chatId)
                    .catch((err) => {
                        logger.error('Channel sticker forward error:', err?.message || err);
                    });
            } else if (allowGroupSticker) {
                void this.stickerForwarder
                    .forwardSticker(this.sock, msg, chatId)
                    .catch((err) => {
                        logger.error('Sticker forward error:', err?.message || err);
                    });
            }
        }

        if (msg.key.fromMe || isChannel) {
            return;
        }

        const senderJid = getMessageSenderJid(msg.key);
        if (chatId.endsWith('@g.us') && !senderJid) {
            logger.warn('Group message with no sender participant; ignoring');
            return;
        }

        // Store user information (JID -> pushName mapping) for later retrieval
        if (senderJid && msg.pushName && this.userManager) {
            void this.userManager.updateUser(senderJid, msg.pushName).catch(() => {});
        }

        const messageText = getTextFromWAMessage(msg.message).trim();
        const textForUrls = getTextForUrlScan(msg.message).trim();

        if (messageText.startsWith('/')) {
            void this.commandController
                .handleCommand(this.sock, chatId, messageText, senderJid, msg, msg.pushName)
                .catch((err) => {
                    logger.error('Command error:', err?.message || err);
                    logger.error('Command error stack:', err?.stack);
                });
            return;
        }

        if (textForUrls.length > 0) {
            const igUrl = extractInstagramUrl(textForUrls);
            if (igUrl && (await this.shouldAutoDownloadInsta(chatId))) {
                void this.commandController
                    .handleInsta(this.sock, chatId, [igUrl], msg, { requireCommandArgs: false })
                    .catch((err) => {
                        logger.error('Insta auto-download error:', err?.message || err);
                    });
            }
        }
    }

    /** DMs: always auto. Groups: only when `/instaon` was used in that group. */
    async shouldAutoDownloadInsta(chatId) {
        if (shouldAutoDetectInstaLink(chatId)) {
            return true;
        }
        if (chatId?.endsWith('@g.us') && this.groupManager) {
            return this.groupManager.isInstaAutoEnabled(chatId);
        }
        return false;
    }

    getSock() {
        return this.sock;
    }

    getIsReady() {
        return this.isReady;
    }

    async waitForReady() {
        while (!this.isReady) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

export default WhatsAppService;
