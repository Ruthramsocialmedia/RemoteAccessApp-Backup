/**
 * Health Monitor - Detects dead/timed-out device connections
 * 
 * Two-tier timeout:
 * - 90s no heartbeat → "sleeping" (device may still be alive, OEM throttling)
 * - 5 min no heartbeat → "offline" (OEM killed the process)
 *   → Sends FCM wake push before marking offline
 */

import { fcmSender } from './fcmSender.js';

class HealthMonitor {
    constructor(socketRegistry) {
        this.registry = socketRegistry;
        this.CHECK_INTERVAL = 30000; // Check every 30s
        this.SLEEP_TIMEOUT_MS = 90000; // 90s → sleeping (may be alive but unresponsive)
        this.OFFLINE_TIMEOUT_MS = 300000; // 5 min → truly offline (process likely killed)
        this.monitorInterval = null;
    }

    /**
     * Start health monitoring
     */
    start() {
        console.log('[HealthMonitor] Starting health monitor...');
        console.log(`[HealthMonitor] Check interval: ${this.CHECK_INTERVAL}ms`);
        console.log(`[HealthMonitor] Sleep threshold: ${this.SLEEP_TIMEOUT_MS}ms, Offline threshold: ${this.OFFLINE_TIMEOUT_MS}ms`);

        this.monitorInterval = setInterval(() => {
            this.checkDeviceHealth();
        }, this.CHECK_INTERVAL);
    }

    /**
     * Stop health monitoring
     */
    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
            console.log('[HealthMonitor] Health monitor stopped');
        }
    }

    /**
     * Check all devices for timeout — two-tier system:
     * - 90s no heartbeat → "sleeping" (device may still be alive)
     * - 5 min no heartbeat → "offline" (OEM killed the process)
     */
    checkDeviceHealth() {
        const now = Date.now();
        const devices = this.registry.listDevices();
        let sleepCount = 0;
        let deadCount = 0;
        let zombieCount = 0;

        for (const device of devices) {
            // Skip already-offline devices
            if (device.status === 'offline') continue;

            // ── Zombie socket detection ──
            // If metadata says online/sleep but the actual WS is dead, fix immediately
            const deviceConn = this.registry.getDevice(device.deviceId);
            if (deviceConn) {
                const wsAlive = deviceConn.ws && deviceConn.ws.readyState === 1; // 1 = OPEN
                if (!wsAlive && (device.status === 'online' || device.status === 'sleep')) {
                    console.log(`[HealthMonitor] 🧟 Zombie socket detected for ${device.deviceId} — status was "${device.status}" but WS is dead`);

                    // Try FCM wake push
                    const fcmToken = deviceConn.metadata?.fcmToken;
                    if (fcmToken) {
                        fcmSender.wakeDevice(fcmToken, device.deviceId).catch(() => { });
                    }

                    this.registry.markOffline(device.deviceId);
                    zombieCount++;
                    continue; // Skip further checks for this device
                }
            }

            // Use lastHeartbeat if available, otherwise lastSeen
            const lastHeartbeat = device.lastHeartbeat || device.lastSeen;
            if (!lastHeartbeat) continue;

            const lastHeartbeatTime = new Date(lastHeartbeat).getTime();
            const elapsed = now - lastHeartbeatTime;

            // Tier 2: 5 min → truly offline (force disconnect)
            if (elapsed > this.OFFLINE_TIMEOUT_MS) {
                console.log(`[HealthMonitor] ⚠️ Device ${device.deviceId} OFFLINE (${Math.round(elapsed / 1000)}s since last heartbeat)`);

                // Try FCM wake push BEFORE marking offline
                const deviceConn = this.registry.getDevice(device.deviceId);
                const fcmToken = deviceConn?.metadata?.fcmToken;
                if (fcmToken) {
                    fcmSender.wakeDevice(fcmToken, device.deviceId).catch(() => { });
                }

                // Force disconnect
                if (deviceConn && deviceConn.ws) {
                    try {
                        deviceConn.ws.close(1001, 'Heartbeat timeout');
                    } catch (e) {
                        console.error(`[HealthMonitor] Error closing socket: ${e.message}`);
                    }
                }

                this.registry.markOffline(device.deviceId);
                deadCount++;
            }
            // Tier 1: 90s → sleeping (still could be alive, OEM throttling)
            else if (elapsed > this.SLEEP_TIMEOUT_MS && device.status === 'online') {
                console.log(`[HealthMonitor] 💤 Device ${device.deviceId} → sleeping (${Math.round(elapsed / 1000)}s since last heartbeat)`);
                this.registry.markSleep(device.deviceId);
                sleepCount++;
            }
        }

        // Log summary
        if (deadCount > 0 || sleepCount > 0 || zombieCount > 0) {
            console.log(`[HealthMonitor] Status: ${sleepCount} sleeping, ${deadCount} offline, ${zombieCount} zombie(s) cleaned`);
        }

        const onlineDevices = devices.filter(d => d.status === 'online' || d.status === 'sleep');
        if (devices.length > 0) {
            console.log(`[HealthMonitor] Active devices: ${onlineDevices.length}/${devices.length} total`);
        }
    }

    /**
     * Get device health status
     */
    getDeviceStatus(deviceId) {
        const device = this.registry.getDevice(deviceId);
        if (!device) {
            return { status: 'offline', reason: 'not_registered' };
        }

        const lastHeartbeat = device.metadata.lastHeartbeat || device.metadata.lastSeen;
        if (!lastHeartbeat) {
            return { status: 'unknown', reason: 'no_heartbeat_data' };
        }

        const now = Date.now();
        const lastHeartbeatTime = new Date(lastHeartbeat).getTime();
        const elapsed = now - lastHeartbeatTime;

        if (elapsed > this.OFFLINE_TIMEOUT_MS) {
            return {
                status: 'offline',
                reason: 'timeout',
                lastHeartbeat: lastHeartbeat,
                elapsed: elapsed,
            };
        }

        if (elapsed > this.SLEEP_TIMEOUT_MS) {
            return {
                status: 'sleep',
                reason: 'no_heartbeat',
                lastHeartbeat: lastHeartbeat,
                elapsed: elapsed,
            };
        }

        return {
            status: 'online',
            lastHeartbeat: lastHeartbeat,
            elapsed: elapsed,
        };
    }
}

export default HealthMonitor;
