/**
 * Socket Registry - Manages active device WebSocket connections
 * Now with Supabase persistence for device data
 */

import { upsertDevice, updateDeviceStatus, getAllDevices, deleteDeviceFromDB } from './database.js';
import { commandDispatcher } from './commandDispatcher.js';

class SocketRegistry {
    constructor() {
        // Map of deviceId -> { ws, metadata }
        this.devices = new Map();
    }

    /**
     * Load devices from Supabase on server startup
     * All loaded devices are marked offline (no active WS yet)
     */
    async loadFromDB() {
        try {
            const dbDevices = await getAllDevices();
            if (dbDevices.length === 0) {
                console.log('[Registry] No devices in database');
                return;
            }

            for (const row of dbDevices) {
                // Parse stored metadata or build from columns
                let metadata = {};
                try {
                    metadata = row.metadata ? JSON.parse(row.metadata) : {};
                } catch (e) {
                    metadata = {};
                }

                this.devices.set(row.device_id, {
                    ws: null, // No active connection yet
                    metadata: {
                        ...metadata,
                        model: row.model || metadata.model,
                        manufacturer: row.manufacturer || metadata.manufacturer,
                        androidVersion: row.android_version || metadata.androidVersion,
                        battery: row.battery || metadata.battery,
                        status: 'offline', // All loaded devices start offline
                        connectedAt: row.connected_at,
                        lastSeen: row.last_seen,
                    },
                });
            }

            console.log(`[Registry] Loaded ${dbDevices.length} device(s) from database (all marked offline)`);
        } catch (err) {
            console.error('[Registry] Error loading from database:', err.message);
        }
    }

    /**
     * Register a new device connection
     * Closes old socket if device already registered (handles reconnects)
     */
    register(deviceId, ws, metadata = {}) {
        // Check if device already registered
        const existing = this.devices.get(deviceId);
        if (existing) {
            console.log(`[Registry] Device ${deviceId} already registered - closing old socket`);

            // Close old socket to prevent ghost connections
            try {
                if (existing.ws && existing.ws.readyState === existing.ws.OPEN) {
                    existing.ws.close(1000, 'Replaced by new connection');
                }
            } catch (e) {
                console.error(`[Registry] Error closing old socket: ${e.message}`);
            }
        }

        // Register new connection
        const deviceMetadata = {
            ...metadata,
            status: 'online',
            connectedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
        };

        this.devices.set(deviceId, {
            ws,
            metadata: deviceMetadata,
        });

        console.log(`[Registry] Device registered: ${deviceId}`);
        console.log(`[Registry] Total devices: ${this.devices.size}`);

        // Persist to Supabase (fire & forget)
        upsertDevice(deviceId, deviceMetadata);

        // Flush any scheduled commands for this device (with delay for device to fully init)
        setTimeout(() => {
            commandDispatcher.flushScheduled(deviceId);
        }, 5000);
    }

    /**
     * Mark device as offline (don't delete - keep history)
     */
    markOffline(deviceId) {
        const device = this.devices.get(deviceId);
        if (device) {
            device.metadata.status = 'offline';
            device.metadata.lastSeen = new Date().toISOString();
            device.ws = null; // Remove socket reference

            console.log(`[Registry] Device marked offline: ${deviceId}`);

            // Persist to Supabase
            updateDeviceStatus(deviceId, 'offline');
        }
    }

    /**
     * Mark device as sleeping (screen off, app still running)
     */
    markSleep(deviceId) {
        const device = this.devices.get(deviceId);
        if (device) {
            device.metadata.status = 'sleep';
            device.metadata.lastSeen = new Date().toISOString();
            console.log(`[Registry] Device marked sleep: ${deviceId}`);

            // Persist to Supabase
            updateDeviceStatus(deviceId, 'sleep');
        }
    }

    /**
     * Permanently delete a device (admin action only)
     */
    deleteDevice(deviceId) {
        const removed = this.devices.delete(deviceId);
        if (removed) {
            console.log(`[Registry] Device permanently deleted: ${deviceId}`);

            // Remove from Supabase too
            deleteDeviceFromDB(deviceId);
        }
        return removed;
    }

    /**
     * Get a specific device connection
     */
    getDevice(deviceId) {
        return this.devices.get(deviceId);
    }

    /**
     * Update device metadata
     */
    updateMetadata(deviceId, metadata) {
        const device = this.devices.get(deviceId);
        if (device) {
            device.metadata = {
                ...device.metadata,
                ...metadata,
                lastSeen: new Date().toISOString(),
            };
        }
    }

    /**
     * List all connected devices
     */
    listDevices() {
        const deviceList = [];
        for (const [deviceId, device] of this.devices.entries()) {
            deviceList.push({
                deviceId,
                ...device.metadata,
            });
        }
        return deviceList;
    }

    /**
     * Check if device is online
     */
    isOnline(deviceId) {
        const device = this.devices.get(deviceId);
        return device && device.metadata.status === 'online';
    }

    /**
     * Get only online devices
     */
    getOnlineDevices() {
        const onlineDevices = [];
        for (const [deviceId, device] of this.devices.entries()) {
            if (device.metadata.status === 'online') {
                onlineDevices.push({
                    deviceId,
                    ...device.metadata,
                });
            }
        }
        return onlineDevices;
    }

    /**
     * Get device count
     */
    getDeviceCount() {
        return this.devices.size;
    }
}

// Singleton instance
export const socketRegistry = new SocketRegistry();
export default socketRegistry;
