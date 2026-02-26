/**
 * Command Dispatcher - Routes JSON commands to devices and handles responses
 * Now with in-memory command history + optional Supabase persistence
 */

import { socketRegistry } from './socketRegistry.js';
import { saveCommandHistory, getCommandHistory, saveScheduledQueue, loadAllScheduledQueues } from './database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUEUE_FILE = path.join(__dirname, '../../data/scheduled_queue.json');


class CommandDispatcher {
    constructor() {
        // Map of commandId -> { resolve, reject, timeout }
        this.pendingCommands = new Map();
        this.commandIdCounter = 0;

        // In-memory command history (works without DB)
        this.history = [];
        this.maxHistorySize = 500; // Keep last 500 commands in memory

        // Scheduled commands: deviceId -> [{id, action, payload, scheduledAt}]
        this.scheduledCommands = new Map();
        this._loadQueue(); // Restore scheduled queue from disk on startup

    }

    /**
     * Generate unique command ID
     */
    generateCommandId() {
        return `cmd_${Date.now()}_${++this.commandIdCounter}`;
    }

    /**
     * Send a command to a device and wait for response
     * @param {string} deviceId - Target device ID
     * @param {string} action - Command action
     * @param {object} payload - Command payload
     * @param {number} timeout - Timeout in milliseconds (default: 30000)
     * @returns {Promise} Response data
     */
    sendCommand(deviceId, action, payload = {}, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const device = socketRegistry.getDevice(deviceId);

            if (!device) {
                reject(new Error(`Device ${deviceId} not found`));
                return;
            }

            // Check if WebSocket is actually connected
            if (!device.ws || device.ws.readyState !== 1) {
                reject(new Error(`Device ${deviceId} is offline`));
                return;
            }

            const commandId = this.generateCommandId();
            const command = {
                id: commandId,
                action,
                payload,
            };

            // Set up timeout
            const timeoutHandle = setTimeout(() => {
                this.pendingCommands.delete(commandId);

                // Log timeout to history
                this._logCommand(deviceId, commandId, action, payload, 'timeout', null, timeout);

                reject(new Error(`Command ${commandId} timed out after ${timeout}ms`));
            }, timeout);

            // Store pending command
            this.pendingCommands.set(commandId, {
                resolve,
                reject,
                timeout: timeoutHandle,
                deviceId,
                action,
                payload,
                sentAt: Date.now(),
            });

            // Send command
            try {
                device.ws.send(JSON.stringify(command));
                console.log(`[Dispatcher] Command sent: ${commandId} -> ${deviceId} (${action})`);
            } catch (error) {
                clearTimeout(timeoutHandle);
                this.pendingCommands.delete(commandId);

                // Log failed send to history
                this._logCommand(deviceId, commandId, action, payload, 'failed', null, 0);

                reject(error);
            }
        });
    }

    /**
     * Handle response from device
     * @param {object} response - Response from device
     */
    handleResponse(response) {
        const { replyTo, status, data, error } = response;

        if (!replyTo) {
            console.warn('[Dispatcher] Received response without replyTo field');
            return;
        }

        const pending = this.pendingCommands.get(replyTo);
        if (!pending) {
            console.warn(`[Dispatcher] Received response for unknown command: ${replyTo}`);
            return;
        }

        // Clean up
        clearTimeout(pending.timeout);
        this.pendingCommands.delete(replyTo);

        const duration = Date.now() - pending.sentAt;
        console.log(`[Dispatcher] Response received: ${replyTo} (${duration}ms) - ${status}`);

        // Log to history
        this._logCommand(
            pending.deviceId,
            replyTo,
            pending.action,
            pending.payload,
            status,
            status === 'success' ? data : error,
            duration
        );

        // Resolve or reject based on status
        // NOTE: Android sends errors nested inside `data` (e.g. data.error = "device_locked")
        // so we check data?.error as a fallback when the top-level error field is empty
        if (status === 'success') {
            pending.resolve(data);
        } else {
            const errorMsg = error || (data && data.error) || 'Command failed';
            console.log(`[Dispatcher] ❌ Command rejected: "${errorMsg}" (action: ${pending.action})`);
            pending.reject(new Error(errorMsg));
        }
    }

    /**
     * Log command to in-memory history + optional DB persistence
     */
    _logCommand(deviceId, commandId, action, payload, status, response, durationMs) {
        const entry = {
            deviceId,
            commandId,
            action,
            payload,
            status, // 'success', 'failed', 'timeout'
            response: this._truncateResponse(response),
            durationMs,
            timestamp: new Date().toISOString(),
        };

        this.history.unshift(entry); // newest first

        // Trim to max size
        if (this.history.length > this.maxHistorySize) {
            this.history = this.history.slice(0, this.maxHistorySize);
        }

        // Persist to Supabase (fire & forget — won't block or break if DB is down)
        saveCommandHistory(entry);
    }

    /**
     * Truncate large responses to avoid memory bloat
     */
    _truncateResponse(response) {
        if (!response) return null;
        const str = typeof response === 'string' ? response : JSON.stringify(response);
        if (str.length > 500) {
            return str.substring(0, 500) + '... [truncated]';
        }
        try {
            return JSON.parse(str);
        } catch {
            return str;
        }
    }

    /**
     * Get command history (optionally filtered by device)
     */
    getHistory(deviceId = null, limit = 100) {
        let results = this.history;
        if (deviceId) {
            results = results.filter(h => h.deviceId === deviceId);
        }
        return results.slice(0, limit);
    }

    /**
     * Clear history for a device (or all)
     */
    clearHistory(deviceId = null) {
        if (deviceId) {
            this.history = this.history.filter(h => h.deviceId !== deviceId);
        } else {
            this.history = [];
        }
    }

    /**
     * Load command history from Supabase on startup (supplements in-memory)
     */
    async loadHistoryFromDB() {
        try {
            const dbHistory = await getCommandHistory(null, this.maxHistorySize);
            if (dbHistory.length > 0) {
                // Map DB columns to in-memory format
                const mapped = dbHistory.map(row => ({
                    deviceId: row.device_id,
                    commandId: row.command_id,
                    action: row.action,
                    payload: row.payload,
                    status: row.status,
                    response: row.response,
                    durationMs: row.duration_ms,
                    timestamp: row.created_at,
                }));
                // Merge with existing (in-memory takes priority for duplicates)
                const existingIds = new Set(this.history.map(h => h.commandId));
                const newEntries = mapped.filter(h => !existingIds.has(h.commandId));
                this.history = [...this.history, ...newEntries]
                    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                    .slice(0, this.maxHistorySize);
                console.log(`[Dispatcher] Loaded ${newEntries.length} commands from database`);
            }
        } catch (err) {
            console.error('[Dispatcher] Error loading history from DB:', err.message);
        }
    }

    /**
     * Get pending commands count
     */
    getPendingCount() {
        return this.pendingCommands.size;
    }

    /**
     * Clear all pending commands for a device (on disconnect)
     */
    clearDeviceCommands(deviceId) {
        let cleared = 0;
        for (const [commandId, pending] of this.pendingCommands.entries()) {
            if (pending.deviceId === deviceId) {
                clearTimeout(pending.timeout);
                pending.reject(new Error(`Device ${deviceId} disconnected`));
                this.pendingCommands.delete(commandId);
                cleared++;
            }
        }
        if (cleared > 0) {
            console.log(`[Dispatcher] Cleared ${cleared} pending commands for ${deviceId}`);
        }
    }
    // ========== QUEUE PERSISTENCE ==========

    _saveQueue() {
        // 1. Save to JSON file (works always, no DB needed)
        try {
            const dir = path.dirname(QUEUE_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const obj = {};
            for (const [deviceId, cmds] of this.scheduledCommands.entries()) {
                obj[deviceId] = cmds;
            }
            fs.writeFileSync(QUEUE_FILE, JSON.stringify(obj, null, 2), 'utf8');
        } catch (e) {
            console.error('[Dispatcher] Failed to save queue to file:', e.message);
        }

        // 2. Also sync to Supabase DB (fire & forget — won't break if DB is down)
        for (const [deviceId, cmds] of this.scheduledCommands.entries()) {
            saveScheduledQueue(deviceId, cmds).catch(() => { });
        }
    }

    _loadQueue() {
        // Load from JSON file (synchronous, works offline)
        try {
            if (fs.existsSync(QUEUE_FILE)) {
                const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
                const obj = JSON.parse(raw);
                for (const [deviceId, cmds] of Object.entries(obj)) {
                    if (Array.isArray(cmds) && cmds.length > 0) {
                        this.scheduledCommands.set(deviceId, cmds);
                    }
                }
                console.log(`[Dispatcher] Loaded scheduled queue from file (${this.scheduledCommands.size} device(s))`);
            }
        } catch (e) {
            console.error('[Dispatcher] Failed to load queue from file:', e.message);
        }
    }

    /**
     * Called after server startup to merge DB queue over file queue.
     * DB is the authoritative source — it overrides the file if both exist.
     * Call this from index.js after everything is initialized.
     */
    async loadQueueFromDB() {
        try {
            const dbQueues = await loadAllScheduledQueues();
            let count = 0;
            for (const [deviceId, cmds] of Object.entries(dbQueues)) {
                // Merge: DB entries take priority over whatever the file had
                this.scheduledCommands.set(deviceId, cmds);
                count++;
            }
            if (count > 0) {
                console.log(`[Dispatcher] Loaded scheduled queue from DB (${count} device(s)) — merged with file`);
                this._saveQueue(); // Keep file in sync with DB
            }
        } catch (e) {
            console.error('[Dispatcher] Failed to load queue from DB:', e.message);
        }
    }

    // ========== SCHEDULED COMMANDS (for offline / locked devices) ==========

    scheduleCommand(deviceId, action, payload = {}) {
        if (!this.scheduledCommands.has(deviceId)) {
            this.scheduledCommands.set(deviceId, []);
        }
        const entry = {
            id: this.generateCommandId(),
            action,
            payload,
            scheduledAt: new Date().toISOString(),
        };
        this.scheduledCommands.get(deviceId).push(entry);
        this._saveQueue(); // Persist immediately
        console.log(`[Dispatcher] Command scheduled for ${deviceId}: ${action} (${entry.id})`);
        return entry;
    }

    /**
     * Flush scheduled commands when a device comes back online / unlocks.
     * Each command is removed from the queue ONLY after it succeeds.
     * If it fails (e.g. device still locked on boot), it stays and retries next unlock.
     */
    async flushScheduled(deviceId) {
        const queue = this.scheduledCommands.get(deviceId);
        if (!queue || queue.length === 0) return;

        console.log(`[Dispatcher] Flushing ${queue.length} scheduled command(s) for ${deviceId}`);
        const snapshot = [...queue]; // snapshot to iterate safely

        for (const cmd of snapshot) {
            try {
                console.log(`[Dispatcher] Executing scheduled: ${cmd.action} (${cmd.id})`);
                await this.sendCommand(deviceId, cmd.action, cmd.payload, 60000);

                // SUCCESS: remove only this command from the persisted queue
                const currentQueue = this.scheduledCommands.get(deviceId);
                if (currentQueue) {
                    const idx = currentQueue.findIndex(c => c.id === cmd.id);
                    if (idx >= 0) currentQueue.splice(idx, 1);
                    if (currentQueue.length === 0) this.scheduledCommands.delete(deviceId);
                    this._saveQueue();
                    console.log(`[Dispatcher] ✅ Scheduled cmd done, removed from queue: ${cmd.id}`);
                }
            } catch (e) {
                // FAILURE: leave in queue — retry on next unlock/reconnect event
                console.warn(`[Dispatcher] ⚠️ Scheduled cmd FAILED, keeping in queue: ${cmd.action} (${e.message})`);
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    /**
     * Get scheduled commands for a device
     */
    getScheduled(deviceId) {
        return this.scheduledCommands.get(deviceId) || [];
    }

    /**
     * Cancel a scheduled command
     */
    cancelScheduled(deviceId, commandId) {
        const queue = this.scheduledCommands.get(deviceId);
        if (!queue) return false;
        const idx = queue.findIndex(c => c.id === commandId);
        if (idx >= 0) {
            queue.splice(idx, 1);
            if (queue.length === 0) this.scheduledCommands.delete(deviceId);
            this._saveQueue(); // Persist cancellation
            console.log(`[Dispatcher] Cancelled scheduled command: ${commandId}`);
            return true;
        }
        return false;
    }
}

// Singleton instance
export const commandDispatcher = new CommandDispatcher();
export default commandDispatcher;
