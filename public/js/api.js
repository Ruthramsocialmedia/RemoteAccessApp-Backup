/**
 * Shared API Helper for Admin Dashboard
 */

class RemoteAPI {
    constructor() {
        this.baseURL = window.location.origin;
        this.ws = null;
        this.deviceId = new URLSearchParams(window.location.search).get('deviceId');
        this.csrfToken = null;
        this.initPromise = this.initCsrf();
    }

    /**
     * Fetch CSRF token on startup
     * If session is expired (401), redirect to login immediately.
     */
    async initCsrf() {
        try {
            const res = await fetch(`${this.baseURL}/auth/check`, { credentials: 'same-origin' });

            // Session expired — redirect to login before any API calls can fail
            if (res.status === 401) {
                // Don't redirect if already on the login page
                if (!window.location.pathname.includes('login')) {
                    console.warn('[API] Session expired — redirecting to login');
                    window.location.href = '/login.html';
                }
                return;
            }

            const data = await res.json();
            if (data.success && data.csrfToken) {
                this.csrfToken = data.csrfToken;
            }
        } catch (e) {
            console.error('Failed to init CSRF token', e);
        }
    }

    /**
     * Make API request
     */
    async request(endpoint, options = {}) {
        await this.initPromise;
        try {
            const { headers: extraHeaders, ...restOptions } = options;
            const response = await fetch(`${this.baseURL}/api${endpoint}`, {
                ...restOptions,
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
                    ...extraHeaders,
                },
                credentials: 'same-origin',
            });

            // Redirect to login if session expired
            if (response.status === 401) {
                window.location.href = '/login.html';
                return;
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            return data;
        } catch (error) {
            // Don't auto-show toast — let each caller handle errors to avoid double toasts
            throw error;
        }
    }

    /**
     * Get all connected devices
     */
    async getDevices() {
        return this.request('/devices');
    }

    /**
     * Get device info
     */
    async getDeviceInfo(deviceId) {
        return this.request(`/device/${deviceId}/info`);
    }

    /**
     * Send command to device
     */
    async sendCommand(deviceId, action, payload = {}) {
        return this.request(`/command/${deviceId}`, {
            method: 'POST',
            body: JSON.stringify({ action, payload }),
        });
    }

    /**
     * Upload file to device
     */
    async uploadFile(deviceId, file, targetPath) {
        await this.initPromise;
        const formData = new FormData();
        formData.append('file', file);
        formData.append('targetPath', targetPath);

        try {
            const response = await fetch(`${this.baseURL}/api/upload/${deviceId}`, {
                method: 'POST',
                body: formData,
                headers: {
                    ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
                },
                credentials: 'same-origin',
            });

            // Redirect to login if session expired
            if (response.status === 401) {
                window.location.href = '/login.html';
                return;
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Upload failed');
            }

            this.showToast('File uploaded successfully', 'success');
            return data;
        } catch (error) {
            this.showToast(error.message, 'error');
            throw error;
        }
    }

    /**
     * Download file from device
     */
    downloadFile(deviceId, filePath) {
        const url = `${this.baseURL}/api/download/${deviceId}?path=${encodeURIComponent(filePath)}`;
        window.open(url, '_blank');
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        // Create toast container if it doesn't exist
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 10000;
                display: flex;
                flex-direction: column-reverse;
                gap: 8px;
                pointer-events: none;
            `;
            document.body.appendChild(container);
        }

        const colors = {
            success: { accent: '#00ff41', bg: 'rgba(0, 255, 65, 0.06)', border: 'rgba(0, 255, 65, 0.2)', glow: 'rgba(0, 255, 65, 0.08)' },
            error: { accent: '#ff3333', bg: 'rgba(255, 51, 51, 0.06)', border: 'rgba(255, 51, 51, 0.2)', glow: 'rgba(255, 51, 51, 0.08)' },
            info: { accent: '#00aaff', bg: 'rgba(0, 170, 255, 0.06)', border: 'rgba(0, 170, 255, 0.2)', glow: 'rgba(0, 170, 255, 0.08)' },
            warning: { accent: '#ffaa00', bg: 'rgba(255, 170, 0, 0.06)', border: 'rgba(255, 170, 0, 0.2)', glow: 'rgba(255, 170, 0, 0.08)' }
        };
        const c = colors[type] || colors.info;

        const icons = {
            success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
            error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
            warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
        };

        const toast = document.createElement('div');
        toast.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 16px;
            min-width: 200px;
            max-width: 360px;
            background: rgba(10, 14, 23, 0.92);
            backdrop-filter: blur(16px);
            border: 1px solid ${c.border};
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 16px ${c.glow};
            animation: toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            pointer-events: auto;
        `;

        const iconEl = document.createElement('div');
        iconEl.style.cssText = `flex-shrink: 0; color: ${c.accent}; display: flex; align-items: center;`;
        iconEl.innerHTML = icons[type] || icons.info;

        const textEl = document.createElement('div');
        textEl.style.cssText = `
            font-family: 'Satoshi', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 0.75rem;
            font-weight: 500;
            color: rgba(255, 255, 255, 0.85);
            line-height: 1.3;
            flex: 1;
        `;
        textEl.textContent = message;

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = `
            flex-shrink: 0;
            background: none;
            border: none;
            color: rgba(255, 255, 255, 0.3);
            cursor: pointer;
            padding: 2px;
            display: flex;
            align-items: center;
            transition: color 0.15s;
        `;
        closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        closeBtn.onmouseenter = () => closeBtn.style.color = 'rgba(255,255,255,0.7)';
        closeBtn.onmouseleave = () => closeBtn.style.color = 'rgba(255,255,255,0.3)';

        const dismiss = () => {
            toast.style.animation = 'toastSlideOut 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards';
            setTimeout(() => toast.remove(), 250);
        };

        closeBtn.addEventListener('click', dismiss);
        toast.appendChild(iconEl);
        toast.appendChild(textEl);
        toast.appendChild(closeBtn);

        container.appendChild(toast);

        // Auto-dismiss after 5s
        setTimeout(() => {
            if (toast.parentNode) dismiss();
        }, 5000);
    }

    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes == null || isNaN(bytes) || bytes < 0) return '—';
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Format date
     */
    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleString();
    }

    /**
     * Confirmed Action Flow:
     * Check state → Wake if sleeping → Lock touch → Home → Action → SmartUI
     *
     * @param {string} deviceId - Target device
     * @param {string} action - Command to send (e.g., 'app_uninstall')
     * @param {object} payload - Command payload
     * @param {string} smartUITitle - Title for SmartUI popup
     * @param {object} opts - Options: { onDone, onClose, skipHome, skipLock, actionDelay }
     * @returns {Promise<object>} - Result from the action command
     */
    async confirmedAction(deviceId, action, payload, smartUITitle, opts = {}) {
        const { onDone, onClose, skipHome, skipLock, actionDelay = 1500 } = opts;
        let locked = false;
        console.log(`[confirmedAction] START: action=${action}`);

        try {
            // Step 0: Check device state (locked / sleeping)
            try {
                const stateResult = await this.sendCommand(deviceId, 'device_info');
                const stateData = stateResult.data || stateResult;
                const isScreenLocked = stateData.isScreenLocked || stateData.screenLocked;
                const isScreenOn = stateData.isScreenOn !== undefined ? stateData.isScreenOn : true;

                if (isScreenLocked) {
                    this.showToast('Device is locked — unlock it first', 'error');
                    throw new Error('device_locked');
                }

                if (!isScreenOn) {
                    console.log('[confirmedAction] Device sleeping, waking up...');
                    this.showToast('Waking device...', 'info');
                    await this.sendCommand(deviceId, 'accessibility_key', { key: 'home' });
                    await new Promise(r => setTimeout(r, 1500));
                }
            } catch (e) {
                if (e.message === 'device_locked') throw e;
                console.warn('[confirmedAction] State check failed (continuing):', e.message);
            }

            // Step 1: Press Home so dialog appears on home screen
            try {
                await this.sendCommand(deviceId, 'accessibility_key', { key: 'home' });
                await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                console.warn('[confirmedAction] Home press failed (continuing):', e.message);
            }

            // Step 2: Init SmartUI FIRST (so it's watching when dialog appears)
            let result = null;
            if (typeof SmartUI !== 'undefined') {
                SmartUI.show(deviceId, {
                    title: smartUITitle || 'Confirm Action',
                    onDone: () => {
                        if (onDone) onDone(result);
                    },
                    onClose: () => {
                        if (onClose) onClose(result);
                    }
                });
            }
            await new Promise(r => setTimeout(r, 300));

            // Step 3: THEN trigger the action (dialog appears while SmartUI is watching)
            try {
                result = await this.sendCommand(deviceId, action, payload);
            } catch (actionErr) {
                if (actionErr.message === 'device_locked') throw actionErr;
                console.warn('[confirmedAction] Action returned error (continuing to SmartUI):', actionErr.message);
                result = { error: actionErr.message };
            }

            // Step 4: Lock overlay AFTER prompt appeared (prevent phone user interference)
            if (!skipLock) {
                try {
                    await this.sendCommand(deviceId, 'touch_lock');
                    locked = true;
                } catch (e) {
                    console.warn('[confirmedAction] Touch lock failed (continuing):', e.message);
                }
            }

            // Step 5: Wait for dialog to fully render
            await new Promise(r => setTimeout(r, actionDelay));

            // Step 6: Refresh SmartUI so it picks up the new dialog
            if (typeof SmartUI !== 'undefined') {
                SmartUI.refresh();
            }

            return result;
        } catch (e) {
            // Unlock on error
            if (locked) {
                this.sendCommand(deviceId, 'touch_unlock').catch(() => { });
            }
            throw e;
        }
    }
}

// Add toast animations
const style = document.createElement('style');
style.textContent = `
  @keyframes toastSlideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes toastSlideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
  @keyframes slideIn {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateY(0); opacity: 1; }
    to { transform: translateY(20px); opacity: 0; }
  }
`;
document.head.appendChild(style);

/**
 * HTML escape utility — prevents XSS when inserting dynamic strings into innerHTML.
 * Usage: element.innerHTML = `<div>${escHtml(userInput)}</div>`;
 */
window.escHtml = function (str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

/**
 * JS escape utility — prevents JS injection when inserting dynamic strings into inline event handlers.
 * Usage: onclick="myFunction('${escJs(userInput)}')"
 */
window.escJs = function (str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;');
};

// Global API instance
window.api = new RemoteAPI();
