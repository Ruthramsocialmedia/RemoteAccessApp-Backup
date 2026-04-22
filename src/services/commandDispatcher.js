/**
 * Command Dispatcher - Routes JSON commands to devices and handles responses
 * Now with in-memory command history + optional Supabase persistence
 */

import { socketRegistry } from './socketRegistry.js';
import { saveCommandHistory, getCommandHistory } from './database.js';
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

        // Callback for notifying browsers when schedule changes
        this.onScheduleUpdate = null;

        // ── Delivery ACK tracking ──
        // A command is "delivered" when the device sends cmd_ack.
        // sendCommandWithRetry() uses this to decide whether to retry on reconnect.
        // Capped at 2000 entries to prevent unbounded memory growth.
        this.deliveredCommandIds = new Set();
        this.MAX_DELIVERED_HISTORY = 2000;
    }

    /**
     * Generate unique command ID
     */
    generateCommandId() {
        return `cmd_${Date.now()}_${++this.commandIdCounter}`;
    }

    /**
     * Mark a command as delivered (device sent cmd_ack).
     * Removes it from the pending retry queue so no retry is attempted.
     */
    markDelivered(commandId) {
        this.deliveredCommandIds.add(commandId);
        // Prune oldest if over limit
        if (this.deliveredCommandIds.size > this.MAX_DELIVERED_HISTORY) {
            const firstKey = this.deliveredCommandIds.values().next().value;
            this.deliveredCommandIds.delete(firstKey);
        }
        console.log(`[Dispatcher] cmd_ack received: ${commandId} — marked delivered`);
    }

    /**
     * Send a command with a single retry on disconnect+reconnect.
     *
     * Flow:
     *  1. Send command normally.
     *  2. If device disconnects before ACK arrives:
     *     a. Server waits up to retryWindowMs (default 10s) for reconnect.
     *     b. On reconnect, checks deliveredCommandIds.
     *     c. If still NOT delivered — resend the command once.
     *     d. If already delivered — no retry (device queued it offline).
     *
     * This gives exact at-most-once semantics across short network drops.
     *
     * @param {string} deviceId
     * @param {string} action
     * @param {object} payload
     * @param {number} timeout - command timeout ms (default 30s)
     * @param {number} retryWindowMs - how long to wait for reconnect before giving up retry (default 10s)
     */
    async sendCommandWithRetry(deviceId, action, payload = {}, timeout = 30000, retryWindowMs = 10000) {
        const commandId = this.generateCommandId();

        try {
            return await this._sendCommandWithId(deviceId, commandId, action, payload, timeout);
        } catch (err) {
            // If command timed out or device disconnected, check if we should retry
            const delivered = this.deliveredCommandIds.has(commandId);
            if (delivered) {
                // Device ACK'd it — it was executing when the response path died
                // The device WILL send a response when it finishes; don't retry
                console.log(`[Dispatcher] ${commandId} failed but was ACK'd — no retry (device is executing)`);
                throw err;
            }

            // Not delivered — device never received it. Wait for reconnect, then retry once.
            console.log(`[Dispatcher] ${commandId} not ACK'd — waiting ${retryWindowMs}ms for device reconnect to retry...`);
            await new Promise(r => setTimeout(r, retryWindowMs));

            const device = socketRegistry.getDevice(deviceId);
            if (device && device.ws && device.ws.readyState === 1) {
                console.log(`[Dispatcher] Device ${deviceId} reconnected — retrying ${commandId} (${action}) once`);
                return await this.sendCommand(deviceId, action, payload, timeout);
            } else {
                console.log(`[Dispatcher] Device ${deviceId} still offline after retry window — giving up on ${commandId}`);
                throw new Error(`Device ${deviceId} offline — command ${action} could not be delivered`);
            }
        }
    }

    /**
     * Internal: send a command using a pre-generated ID (used by sendCommandWithRetry)
     */
    _sendCommandWithId(deviceId, commandId, action, payload, timeout) {
        return new Promise((resolve, reject) => {
            const device = socketRegistry.getDevice(deviceId);
            if (!device || !device.ws || device.ws.readyState !== 1) {
                reject(new Error(`Device ${deviceId} is offline`));
                return;
            }

            const command = { id: commandId, action, payload };

            const timeoutHandle = setTimeout(() => {
                this.pendingCommands.delete(commandId);
                this._logCommand(deviceId, commandId, action, payload, 'timeout', null, timeout);
                reject(new Error(`Command ${commandId} timed out after ${timeout}ms`));
            }, timeout);

            this.pendingCommands.set(commandId, {
                resolve, reject,
                timeout: timeoutHandle,
                deviceId, action, payload,
                sentAt: Date.now(),
            });

            try {
                device.ws.send(JSON.stringify(command));
                console.log(`[Dispatcher] Command sent: ${commandId} -> ${deviceId} (${action})`);
            } catch (error) {
                clearTimeout(timeoutHandle);
                this.pendingCommands.delete(commandId);
                this._logCommand(deviceId, commandId, action, payload, 'failed', null, 0);
                reject(error);
            }
        });
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
        // Log response summary — redact PII fields from log output
        if (process.env.NODE_ENV !== 'production') {
            const redacted = response.data ? {
                ...response,
                data: {
                    ...response.data,
                    fingerprint: response.data.fingerprint ? '[REDACTED]' : undefined,
                    ipAddress: response.data.ipAddress ? '[REDACTED]' : undefined,
                    deviceId: response.data.deviceId ? '[REDACTED]' : undefined,
                }
            } : response;
            console.log(`[Dispatcher] RAW RESPONSE DUMP: ${JSON.stringify(redacted)}`);
        }
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

    _saveQueue(removedDeviceIds = []) {
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
        console.log(`[Dispatcher] Will execute when device unlocks (device_unlocked event)`);

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

                if (cmd.action === 'app_uninstall') {
                    // Full overlay flow for uninstall:
                    // wake → home → trigger → lock → auto-confirm → unlock
                    await this._executeScheduledUninstall(deviceId, cmd);
                } else {
                    // Simple execution for other commands
                    await this.sendCommand(deviceId, cmd.action, cmd.payload, 60000);
                }

                // SUCCESS: remove only this command from the persisted queue
                this._removeScheduledCmd(deviceId, cmd.id);
            } catch (e) {
                // FAILURE: auto-confirm may have failed, but user may have manually confirmed
                console.warn(`[Dispatcher] ⚠️ Scheduled cmd error: ${cmd.action} (${e.message})`);
                // Make sure overlay is removed on failure
                try { await this.sendCommand(deviceId, 'touch_unlock', {}, 5000); } catch (_) { }

                // For uninstalls: verify if the package was actually removed
                if (cmd.action === 'app_uninstall' && cmd.payload?.package) {
                    await new Promise(r => setTimeout(r, 3000)); // Wait for uninstall to finish
                    const stillInstalled = await this._isPackageInstalled(deviceId, cmd.payload.package);
                    if (!stillInstalled) {
                        console.log(`[Dispatcher] ✅ Package ${cmd.payload.package} is gone — removing from queue despite auto-confirm failure`);
                        this._removeScheduledCmd(deviceId, cmd.id);
                    } else {
                        console.log(`[Dispatcher] Package ${cmd.payload.package} still installed — keeping in queue`);
                    }
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    /**
     * Remove a single scheduled command from the queue and persist
     */
    _removeScheduledCmd(deviceId, cmdId) {
        const currentQueue = this.scheduledCommands.get(deviceId);
        if (!currentQueue) return;
        const idx = currentQueue.findIndex(c => c.id === cmdId);
        if (idx >= 0) currentQueue.splice(idx, 1);
        const removedDevices = [];
        if (currentQueue.length === 0) {
            this.scheduledCommands.delete(deviceId);
            removedDevices.push(deviceId);
        }
        this._saveQueue(removedDevices);
        console.log(`[Dispatcher] ✅ Scheduled cmd done, removed from queue: ${cmdId}`);
        if (this.onScheduleUpdate) this.onScheduleUpdate(deviceId);
    }

    /**
     * Check if a package is still installed on the device
     */
    async _isPackageInstalled(deviceId, packageName) {
        try {
            const result = await this.sendCommand(deviceId, 'apps_list', {}, 15000);
            const apps = result?.data || [];
            return apps.some(a => a.package === packageName);
        } catch (e) {
            console.warn(`[Dispatcher] Could not verify package installation: ${e.message}`);
            return true; // Assume still installed if we can't check
        }
    }

    /**
     * Execute a scheduled uninstall with overlay + auto-confirm:
     * Dispatches the command to the Android client which natively handles waking,
     * pressing home, and auto-confirming the dialog.
     */
    async _executeScheduledUninstall(deviceId, cmd) {
        console.log(`[Dispatcher] 📦 Scheduled uninstall: ${cmd.payload.package}`);

        // Trigger native heuristic uninstall on Android
        // Pass heuristic: true so the Android client handles auto-confirm robustly via AccessibilityBridge
        await this.sendCommand(deviceId, cmd.action, { package: cmd.payload.package, heuristic: true }, 60000);
        console.log(`[Dispatcher] ✅ Triggered native heuristic uninstall for ${cmd.payload.package}`);
    }

    /**
     * Find a confirm/OK button in the UI tree nodes
     */
    _findConfirmButton(nodes, counter = { i: 0 }) {
        if (!Array.isArray(nodes)) return null;

        for (const node of nodes) {
            const nodeIndex = node.index !== undefined ? node.index : counter.i;
            counter.i++;

            const text = (node.text || '').toLowerCase().trim();
            const desc = (node.contentDescription || '').toLowerCase().trim();
            const id = (node.viewIdResourceName || node.id || '').toLowerCase();

            // Match OK, Uninstall, Confirm buttons (broadened for OEM variations)
            if (node.clickable && (
                text === 'ok' ||
                text === 'uninstall' ||
                text === 'confirm' ||
                text === 'delete' ||
                text === 'remove' ||
                text === 'yes' ||
                text === 'accept' ||
                text === 'continue' ||
                desc === 'ok' ||
                desc === 'uninstall' ||
                desc === 'confirm' ||
                desc === 'delete' ||
                id.includes('button1') ||  // android default OK button
                id.includes('ok') ||
                id.includes('accept')
            )) {
                return { ...node, index: nodeIndex };
            }

            // Search children recursively
            if (node.children) {
                const found = this._findConfirmButton(node.children, counter);
                if (found) return found;
            }
        }
        return null;
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
            const removedDevices = [];
            if (queue.length === 0) {
                this.scheduledCommands.delete(deviceId);
                removedDevices.push(deviceId);
            }
            this._saveQueue(removedDevices); // Persist cancellation
            console.log(`[Dispatcher] Cancelled scheduled command: ${commandId}`);
            if (this.onScheduleUpdate) this.onScheduleUpdate(deviceId);
            return true;
        }
        return false;
    }
}

// Singleton instance
export const commandDispatcher = new CommandDispatcher();
export default commandDispatcher;
