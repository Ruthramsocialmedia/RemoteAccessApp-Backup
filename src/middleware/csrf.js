/**
 * Anti-CSRF Middleware
 * 
 * Verifies that state-changing requests (POST, PUT, DELETE) include
 * a valid X-CSRF-Token header derived from the auth cookie.
 */

import crypto from 'crypto';
import config from '../config.js';

/**
 * Generate a CSRF token based on the user's auth token
 */
export function generateCsrfToken(authToken) {
    if (!authToken) return null;
    return crypto.createHash('sha256')
        .update(authToken + config.secretKey)
        .digest('hex');
}

/**
 * CSRF protection middleware for Admin API routes
 */
export function csrfMiddleware(req, res, next) {
    // Skip CSRF check for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    // Skip CSRF check for endpoints that don't need it or are public
    const skipPaths = [
        '/auth/login',
        '/api/device-upload-temp',
        '/device-upload-temp'
    ];
    if (skipPaths.some(p => req.path === p || req.path.startsWith(p))) {
        return next();
    }

    const providedToken = req.header('X-CSRF-Token');
    if (!providedToken) {
        return res.status(403).json({
            success: false,
            error: 'Missing CSRF token (X-CSRF-Token header required)'
        });
    }

    // Read the auth cookie
    let authCookie = null;
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';');
        for (const cookie of cookies) {
            const [name, ...rest] = cookie.trim().split('=');
            if (name === 'auth_token') {
                authCookie = decodeURIComponent(rest.join('='));
                break;
            }
        }
    }

    if (!authCookie) {
        return res.status(401).json({
            success: false,
            error: 'Missing authentication cookie'
        });
    }

    const expectedToken = generateCsrfToken(authCookie);
    
    // Use timing-safe comparison to prevent timing attacks
    const providedBuf = Buffer.from(providedToken, 'utf8');
    const expectedBuf = Buffer.from(expectedToken, 'utf8');
    
    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
        return res.status(403).json({
            success: false,
            error: 'Invalid CSRF token'
        });
    }

    next();
}

export default csrfMiddleware;
