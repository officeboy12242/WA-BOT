/**
 * Database Auth State
 * Custom auth state handler that stores WhatsApp auth in database instead of files
 * Compatible with Baileys' useMultiFileAuthState
 */

import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import AuthDatabase from '../models/AuthDatabase.js';
import { logger } from './logger.js';

/**
 * Use database for auth state instead of files
 * This makes auth portable and works on Render without persistent disk
 */
export async function useDatabaseAuthState() {
    const authDB = new AuthDatabase();
    authDB.init();

    // Serialize/deserialize with BufferJSON to handle Buffers properly
    const writeData = (data, key) => {
        return authDB.set(key, JSON.stringify(data, BufferJSON.replacer));
    };

    const readData = (key) => {
        try {
            const data = authDB.get(key);
            if (data) {
                return JSON.parse(data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            logger.error(`Error reading ${key}:`, error.message);
            return null;
        }
    };

    // Load credentials from database or create new ones
    const creds = readData('creds') || initAuthCreds();
    
    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        const value = readData(key);
                        if (value) {
                            data[id] = value;
                        }
                    }
                    return data;
                },
                set: (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const key = `${category}-${id}`;
                            const value = data[category][id];
                            if (value) {
                                writeData(value, key);
                            } else {
                                authDB.delete(key);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: () => {
            writeData(creds, 'creds');
        },
        clearAuth: () => {
            authDB.clearAll();
            logger.info('🗑️ Cleared all auth data from database');
        },
        closeDB: () => {
            authDB.close();
        }
    };
}
