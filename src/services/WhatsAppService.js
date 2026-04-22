/**
 * WhatsApp Service
 * Handles WhatsApp connection and event management
 */

import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger.js';
import { useDatabaseAuthState } from '../utils/databaseAuthState.js';

class WhatsAppService {
    constructor(commandController, stickerForwarder = null) {
        this.sock = null;
        this.isReady = false;
        this.commandController = commandController;
        this.stickerForwarder = stickerForwarder;
    }

    async connect() {
        // Use database auth instead of file-based auth
        const { state, saveCreds } = await useDatabaseAuthState();
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

        this.sock.ev.on('creds.update', saveCreds);

        // Listen for messages (commands and stickers)
        this.sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message) return;

            const chatId = msg.key.remoteJid;
            const senderJid = msg.key.participant || msg.key.remoteJid;
            
            // Handle stickers
            if (msg.message.stickerMessage && this.stickerForwarder) {
                await this.stickerForwarder.forwardSticker(this.sock, msg.message.stickerMessage, chatId);
            }

            // Handle commands
            const messageText = msg.message.conversation || 
                               msg.message.extendedTextMessage?.text || 
                               '';
            
            if (messageText.startsWith('/')) {
                await this.commandController.handleCommand(this.sock, chatId, messageText, senderJid);
            }
        });
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
