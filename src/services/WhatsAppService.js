/**
 * WhatsApp Service
 * Handles WhatsApp connection and event management
 */

import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    normalizeMessageContent
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger.js';
import { useDatabaseAuthState } from '../utils/databaseAuthState.js';
import { extractInstagramUrl } from '../utils/instagramUrl.js';
import { getMessageSenderJid, getTextForUrlScan, getTextFromWAMessage } from '../utils/waMessage.js';

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
    constructor(commandController, stickerForwarder = null, authDatabase, groupManager = null) {
        this.sock = null;
        this.isReady = false;
        this.commandController = commandController;
        this.stickerForwarder = stickerForwarder;
        this.authDatabase = authDatabase;
        this.groupManager = groupManager;
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
            }

            if (connection === 'close') {
                this.isReady = false;
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
                
                // Log available chats to help user find chat ID
                try {
                    const chats = await this.sock.groupFetchAllParticipating();
                    logger.info('\n📋 Available Groups:');
                    Object.values(chats).forEach(chat => {
                        logger.info(`  - ${chat.subject}: ${chat.id}`);
                    });
                } catch (err) {
                    logger.error('Error fetching groups:', err.message);
                }
            }
        });

        this.sock.ev.on('creds.update', () => {
            void saveCreds();
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

    async processIncomingMessage(msg) {
        if (!msg?.message || msg.key.fromMe) {
            return;
        }

        const chatId = msg.key.remoteJid;
        const senderJid = getMessageSenderJid(msg.key);
        if (!chatId) {
            return;
        }
        if (chatId.endsWith('@g.us') && !senderJid) {
            logger.warn('Group message with no sender participant; ignoring');
            return;
        }

        const unwrapped = normalizeMessageContent(msg.message) || msg.message;
        if (unwrapped.stickerMessage && this.stickerForwarder) {
            void this.stickerForwarder
                .forwardSticker(this.sock, unwrapped.stickerMessage, chatId)
                .catch((err) => {
                    logger.error('Sticker forward error:', err?.message || err);
                });
        }

        const messageText = getTextFromWAMessage(msg.message).trim();
        const textForUrls = getTextForUrlScan(msg.message).trim();

        if (messageText.startsWith('/')) {
            await this.commandController.handleCommand(
                this.sock,
                chatId,
                messageText,
                senderJid,
                msg
            );
            return;
        }

        if (textForUrls.length > 0) {
            const igUrl = extractInstagramUrl(textForUrls);
            if (igUrl && (await this.shouldAutoDownloadInsta(chatId))) {
                await this.commandController.handleInsta(
                    this.sock,
                    chatId,
                    [igUrl],
                    msg,
                    { requireCommandArgs: false }
                );
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
