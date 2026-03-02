/**
 * FCM Service — Send push notifications using Firebase Admin SDK.
 * 
 * Uses the service account key for authentication (modern approach).
 * When the health monitor detects a device has gone offline,
 * it sends an FCM data message to wake the app process.
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FCMSender {
    constructor() {
        this.initialized = false;

        try {
            let serviceAccount = null;

            // Method 1: Env var (for Render/production)
            if (process.env.FIREBASE_SERVICE_ACCOUNT) {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                console.log('[FCM] Loading credentials from env var');
            } else {
                // Method 2: Local file (for development)
                const serviceAccountPath = path.join(__dirname, '../../firebase-service-account.json');
                serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
                console.log('[FCM] Loading credentials from local file');
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });

            this.messaging = admin.messaging();
            this.initialized = true;
            console.log('[FCM] ✅ Firebase Admin SDK initialized');
        } catch (err) {
            console.log('[FCM] ⚠️ Firebase not initialized — push wake disabled');
            console.log(`[FCM] Reason: ${err.message}`);
        }
    }

    /**
     * Send a wake push to a device.
     * Uses DATA-only message (no notification) with high priority.
     * This ensures onMessageReceived is called even when app is killed.
     */
    async wakeDevice(fcmToken, deviceId) {
        if (!this.initialized) {
            console.log(`[FCM] Cannot wake ${deviceId} — Firebase not initialized`);
            return false;
        }

        if (!fcmToken) {
            console.log(`[FCM] Cannot wake ${deviceId} — no FCM token`);
            return false;
        }

        try {
            console.log(`[FCM] Sending wake push to ${deviceId}...`);

            const result = await this.messaging.send({
                token: fcmToken,
                // DATA message only — no notification
                // This guarantees onMessageReceived is called
                data: {
                    action: 'wake',
                    timestamp: Date.now().toString(),
                    deviceId: deviceId,
                },
                android: {
                    priority: 'high', // Bypass Doze mode
                    ttl: 60000, // Expire after 60s if not delivered
                },
            });

            console.log(`[FCM] ✅ Wake push delivered to ${deviceId} (messageId: ${result})`);
            return true;
        } catch (err) {
            console.error(`[FCM] ❌ Wake push failed for ${deviceId}:`, err.message);

            // Handle invalid/expired token
            if (err.code === 'messaging/invalid-registration-token' ||
                err.code === 'messaging/registration-token-not-registered') {
                console.log(`[FCM] Token expired for ${deviceId} — device needs to re-register`);
            }

            return false;
        }
    }
}

export const fcmSender = new FCMSender();
export default fcmSender;
