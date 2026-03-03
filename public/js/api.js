/**
 * Shared API Helper for Admin Dashboard
 */

class RemoteAPI {
    constructor() {
        this.baseURL = window.location.origin;
        this.ws = null;
        this.deviceId = new URLSearchParams(window.location.search).get('deviceId');
    }

    /**
     * Make API request
     */
    async request(endpoint, options = {}) {
        try {
            const response = await fetch(`${this.baseURL}/api${endpoint}`, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers,
                },
                credentials: 'same-origin',
                ...options,
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
            this.showToast(error.message, 'error');
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
        const formData = new FormData();
        formData.append('file', file);
        formData.append('targetPath', targetPath);

        try {
            const response = await fetch(`${this.baseURL}/api/upload/${deviceId}`, {
                method: 'POST',
                body: formData,
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
      `;
            document.body.appendChild(container);
        }

        // Create toast element
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.style.cssText = `
      background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#3b82f6'};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      margin-bottom: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: slideIn 0.3s ease;
      max-width: 300px;
    `;
        toast.textContent = message;

        container.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    /**
     * Format file size
     */
    formatFileSize(bytes) {
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
                    this.showToast('Device is locked 🔒 — unlock it first', 'error');
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

            // Step 2: Trigger the action (prompt appears on device)
            let result = null;
            try {
                result = await this.sendCommand(deviceId, action, payload);
            } catch (actionErr) {
                console.warn('[confirmedAction] Action returned error (continuing to SmartUI):', actionErr.message);
                result = { error: actionErr.message };
            }

            // Step 3: Lock overlay AFTER prompt appeared (prevent phone user interference)
            if (!skipLock) {
                try {
                    await this.sendCommand(deviceId, 'touch_lock');
                    locked = true;
                } catch (e) {
                    console.warn('[confirmedAction] Touch lock failed (continuing):', e.message);
                }
            }

            // Step 4: Wait for dialog to fully render
            await new Promise(r => setTimeout(r, actionDelay));

            // Step 5: Show SmartUI popup for dashboard user to confirm
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

// Add animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateY(0);
      opacity: 1;
    }
    to {
      transform: translateY(20px);
      opacity: 0;
    }
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

// Global API instance
window.api = new RemoteAPI();
