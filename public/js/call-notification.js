/**
 * call-notification.js — Global incoming call notification overlay
 * Include this script on any page to get floating call alerts.
 * Works on pages with ?deviceId=xxx in URL
 * On index.html (no deviceId), auto-detects the first connected device
 * Requires: api.js loaded before this script
 *
 * Features:
 * - Shows immediately on page load by restoring last known state from localStorage
 * - BroadcastChannel syncs state instantly across all open tabs
 * - Active-call polling every 5s (instead of 60s) to detect call end quickly
 */
(function () {
    var STORAGE_KEY = 'cn_call_state';
    var BC_NAME = 'call_notify_channel';

    var deviceId = new URLSearchParams(window.location.search).get('deviceId');
    var callState = 'IDLE';
    var callerNumber = null;
    var callerName = null;
    var speakerOn = false;
    var ws = null;
    var overlay = null;
    var initialized = false;
    var dismissedForState = null;
    var bc = null; // BroadcastChannel for cross-tab sync

    // ---- Inject CSS ----
    var style = document.createElement('style');
    style.textContent = [
        '#call-notify-overlay {',
        '  position: fixed; top: 0; left: 0; right: 0; z-index: 99999;',
        '  display: none; padding: 0 12px;',
        '  pointer-events: none;',
        '}',
        '#call-notify-overlay.visible {',
        '  display: block;',
        '  animation: callSlideIn 0.35s ease;',
        '}',
        '#call-notify-inner {',
        '  max-width: 560px; margin: 16px auto; padding: 14px 16px;',
        '  border-radius: 12px; pointer-events: auto;',
        '  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;',
        '  font-family: "Share Tech Mono", monospace;',
        '  box-shadow: 0 8px 32px rgba(0,0,0,0.6);',
        '  border: 1px solid rgba(255,255,255,0.1);',
        '}',
        '#call-notify-inner.cn-ringing {',
        '  background: linear-gradient(135deg, #001a00 0%, #003300 100%);',
        '  border-color: #00ff41;',
        '  animation: callPulse 1.5s ease-in-out infinite;',
        '}',
        '#call-notify-inner.cn-active {',
        '  background: linear-gradient(135deg, #001a00 0%, #002d00 100%);',
        '  border-color: #00ff41;',
        '}',
        '.cn-icon { font-size: 26px; flex-shrink: 0; }',
        '.cn-info { flex: 1; min-width: 100px; }',
        '.cn-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 2px; opacity: 0.7; color: #ccc; }',
        '.cn-number { font-size: 1rem; font-weight: 700; margin-top: 2px; color: #00ff41; word-break: break-all; }',
        '.cn-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }',
        '.cn-btn {',
        '  border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer;',
        '  font-weight: 700; font-size: 0.72rem; text-transform: uppercase;',
        '  letter-spacing: 1px; transition: all 0.2s; font-family: inherit;',
        '}',
        '.cn-btn:hover { transform: translateY(-1px); filter: brightness(1.2); }',
        '.cn-btn-answer { background: #10b981; color: #000; }',
        '.cn-btn-answer-mobile { background: #0ea5e9; color: #fff; }',
        '.cn-btn-reject { background: #ef4444; color: #fff; }',
        '.cn-btn-end { background: #ef4444; color: #fff; }',
        '.cn-btn-speaker { background: #3b82f6; color: #fff; }',
        '.cn-btn-speaker.on { background: #f59e0b; color: #000; }',
        '.cn-dismiss {',
        '  background: none; border: 1px solid rgba(255,255,255,0.15);',
        '  color: rgba(255,255,255,0.5); font-size: 16px; cursor: pointer;',
        '  padding: 6px 10px; line-height: 1; border-radius: 6px;',
        '  transition: all 0.15s; flex-shrink: 0; margin-left: auto;',
        '}',
        '.cn-dismiss:hover { color: #fff; background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.3); }',
        '@keyframes callPulse {',
        '  0%, 100% { box-shadow: 0 8px 32px rgba(0,255,65,0.2); }',
        '  50% { box-shadow: 0 8px 32px rgba(0,255,65,0.5); }',
        '}',
        '@keyframes callSlideIn {',
        '  from { transform: translateY(-100%); opacity: 0; }',
        '  to { transform: translateY(0); opacity: 1; }',
        '}',
        '@media (max-width: 480px) {',
        '  #call-notify-inner { padding: 10px 12px; gap: 8px; }',
        '  .cn-number { font-size: 0.9rem; }',
        '  .cn-btn { padding: 7px 10px; font-size: 0.60rem; }',
        '  .cn-actions { width: 100%; flex-wrap: wrap; }',
        '  .cn-actions .cn-btn { flex: 1 1 45%; text-align: center; min-width: 0; }',
        '}',
    ].join('\n');
    document.head.appendChild(style);

    // ---- Inject overlay HTML ----
    overlay = document.createElement('div');
    overlay.id = 'call-notify-overlay';
    overlay.innerHTML =
        '<div id="call-notify-inner">' +
        '<span class="cn-icon" id="cn-icon"></span>' +
        '<div class="cn-info">' +
        '<div class="cn-label" id="cn-label"></div>' +
        '<div class="cn-number" id="cn-number"></div>' +
        '</div>' +
        '<div class="cn-actions" id="cn-actions"></div>' +
        '<button class="cn-dismiss" onclick="window._cnDismiss()" title="Dismiss">&#x2715;</button>' +
        '</div>';
    document.body.appendChild(overlay);

    // ---- BroadcastChannel (cross-tab instant sync) ----
    try {
        bc = new BroadcastChannel(BC_NAME);
        bc.onmessage = function (e) {
            if (e.data && e.data.type === 'call_state_update') {
                // Another tab got a WS push — apply it here without re-broadcasting
                _applyLocal(e.data.state, e.data.number, e.data.name);
            }
        };
    } catch (e) { bc = null; } // Safari < 15.4 fallback — WS still works

    // ---- localStorage state helpers ----
    function saveState(state, number, name) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                state: state, number: number || null, name: name || null,
                ts: Date.now()
            }));
        } catch (e) { }
    }

    function loadState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            // Discard stale state older than 5 minutes
            if (!obj || (Date.now() - obj.ts) > 5 * 60 * 1000) {
                localStorage.removeItem(STORAGE_KEY);
                return null;
            }
            return obj;
        } catch (e) { return null; }
    }

    // ---- Initialize ----
    function init() {
        if (typeof api === 'undefined' || !api.getDevices) {
            setTimeout(init, 500);
            return;
        }

        // Step 1: Immediately restore from localStorage so overlay shows on page load
        var saved = loadState();
        if (saved && saved.state && saved.state !== 'IDLE') {
            _applyLocal(saved.state, saved.number, saved.name);
        }

        if (deviceId) {
            startNotifications();
            return;
        }

        // Auto-detect first device on pages without deviceId
        api.getDevices().then(function (response) {
            if (response && response.devices && response.devices.length > 0) {
                deviceId = response.devices[0].deviceId;
                console.log('[CallNotify] Auto-detected deviceId:', deviceId);
                startNotifications();
            } else {
                console.log('[CallNotify] No devices connected, retrying in 5s...');
                setTimeout(init, 5000);
            }
        }).catch(function () { setTimeout(init, 5000); });
    }

    function startNotifications() {
        if (initialized) return;
        initialized = true;
        console.log('[CallNotify] Starting for device:', deviceId);

        // Initial poll to get fresh state immediately
        pollCurrentState();

        // Active-call polling every 5s so call-ended is detected fast
        setInterval(function () {
            if (callState !== 'IDLE') pollCurrentState();
        }, 5000);

        // Fast fallback poll for detecting new calls even if WS push is missed
        setInterval(pollCurrentState, 15000);

        connectWS();
    }

    // ---- Poll call state ----
    function pollCurrentState() {
        if (!deviceId) return;
        fetch('/api/command/' + deviceId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'call_state', payload: {} })
        }).then(function (r) { return r.json(); })
            .then(function (result) {
                if (!result || !result.success) return;
                var d = result.data;
                if (!d || !d.state) return;
                applyState(d.state, d.number || null, d.contactName || null);
            }).catch(function () { });
    }

    // ---- WebSocket for real-time push ----
    function connectWS() {
        try {
            var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + location.host + '/');
            ws.onopen = function () {
                ws.send(JSON.stringify({ type: 'identify', role: 'browser' }));
            };
            ws.onmessage = function (event) {
                try {
                    var data = JSON.parse(event.data);
                    if (data.type === 'call_state' && data.deviceId === deviceId) {
                        applyState(data.state || 'IDLE', data.number || null, data.contactName || null);
                    }
                } catch (e) { }
            };
            ws.onclose = function () { setTimeout(connectWS, 3000); };
            ws.onerror = function () { try { ws.close(); } catch (e) { } };
        } catch (e) {
            console.error('[CallNotify] WS error:', e);
            setTimeout(connectWS, 5000);
        }
    }

    // ---- Apply state (public: saves to localStorage + broadcasts to other tabs) ----
    function applyState(newState, newNumber, newName) {
        if (newState === callState && newNumber === callerNumber && newName === callerName) return;

        console.log('[CallNotify] State:', newState, newNumber, newName);

        // Save to localStorage so other pages can restore on load
        saveState(newState, newNumber, newName);

        // Broadcast to all other open tabs instantly
        if (bc) {
            try { bc.postMessage({ type: 'call_state_update', state: newState, number: newNumber, name: newName }); } catch (e) { }
        }

        _applyLocal(newState, newNumber, newName);
    }

    // ---- Apply state locally only (no re-broadcast, no re-save) ----
    function _applyLocal(newState, newNumber, newName) {
        var oldState = callState;
        callState = newState;
        callerNumber = newNumber;
        callerName = newName;

        // Reset dismiss guard if this is a new call
        if (newState !== oldState || newNumber !== callerNumber) {
            dismissedForState = null;
        }

        // IDLE = call ended → clear localStorage so it doesn't resurrect
        if (newState === 'IDLE') {
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) { }
        }

        updateOverlay();
    }

    // ---- Update overlay UI ----
    function updateOverlay() {
        var inner = document.getElementById('call-notify-inner');
        var icon = document.getElementById('cn-icon');
        var label = document.getElementById('cn-label');
        var num = document.getElementById('cn-number');
        var actions = document.getElementById('cn-actions');
        if (!inner || !icon || !label || !num || !actions) return;

        var stateKey = callState + ':' + (callerNumber || '') + ':' + (callerName || '');

        if (callState === 'RINGING') {
            if (dismissedForState === stateKey) { overlay.classList.remove('visible'); return; }
            overlay.classList.add('visible');
            inner.className = 'cn-ringing';
            icon.textContent = '\uD83D\uDCF2';
            label.textContent = 'Incoming Call';
            num.textContent = callerName
                ? callerName + ' (' + callerNumber + ')'
                : (callerNumber || 'Unknown');
            actions.innerHTML =
                '<button class="cn-btn cn-btn-answer-mobile" onclick="window._cnAnswerOnMobile()">&#x1F4F1; ON MOBILE</button>' +
                '<button class="cn-btn cn-btn-answer" onclick="window._cnAnswer()">&#x1F5A5; VIA DASHBOARD</button>' +
                '<button class="cn-btn cn-btn-reject" onclick="window._cnReject()">&#x2716; REJECT</button>';

        } else if (callState === 'OFFHOOK') {
            if (dismissedForState === stateKey) { overlay.classList.remove('visible'); return; }
            overlay.classList.add('visible');
            inner.className = 'cn-active';
            icon.textContent = '\uD83D\uDCDE';
            label.textContent = 'Call Active';
            num.textContent = callerName
                ? callerName + ' (' + callerNumber + ')'
                : (callerNumber || 'On Call');
            var spkClass = speakerOn ? 'cn-btn cn-btn-speaker on' : 'cn-btn cn-btn-speaker';
            actions.innerHTML =
                '<button class="' + spkClass + '" onclick="window._cnSpeaker()">&#x1F50A; ' + (speakerOn ? 'SPEAKER ON' : 'SPEAKER') + '</button>' +
                '<button class="cn-btn cn-btn-end" onclick="window._cnEnd()">&#x2716; END</button>';

        } else {
            // IDLE — immediately hide and clear
            overlay.classList.remove('visible');
            inner.className = '';
            speakerOn = false;
            callerNumber = null;
            callerName = null;
            dismissedForState = null;
        }
    }

    // ---- Action helper ----
    function sendCallAction(action, payload) {
        return fetch('/api/command/' + deviceId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action, payload: payload || {} })
        }).then(function (r) { return r.json(); });
    }

    // ---- Global action handlers ----
    window._cnAnswerOnMobile = function () {
        // Dismiss the notification — the phone keeps ringing, user answers physically on the device
        if (typeof api !== 'undefined') api.showToast('Answer the call on your mobile device', 'info');
        var stateKey = callState + ':' + (callerNumber || '') + ':' + (callerName || '');
        dismissedForState = stateKey;
        overlay.classList.remove('visible');
    };

    window._cnAnswer = function () {
        sendCallAction('call_answer').then(function (r) {
            if (typeof api !== 'undefined') api.showToast(r.success ? 'Answering call via dashboard...' : ('Answer failed: ' + (r.error || 'unknown')), r.success ? 'success' : 'error');
        }).catch(function () { if (typeof api !== 'undefined') api.showToast('Answer failed', 'error'); });
    };

    window._cnReject = function () {
        sendCallAction('call_end').then(function (r) {
            if (typeof api !== 'undefined') api.showToast(r.success ? 'Call rejected' : ('Reject failed: ' + (r.error || 'unknown')), r.success ? 'success' : 'error');
        }).catch(function () { if (typeof api !== 'undefined') api.showToast('Reject failed', 'error'); });
    };

    window._cnEnd = function () {
        sendCallAction('call_end').then(function (r) {
            if (typeof api !== 'undefined') api.showToast(r.success ? 'Call ended' : ('End failed: ' + (r.error || 'unknown')), r.success ? 'success' : 'error');
        }).catch(function () { if (typeof api !== 'undefined') api.showToast('End call failed', 'error'); });
    };

    window._cnSpeaker = function () {
        speakerOn = !speakerOn;
        sendCallAction('call_speaker', { on: speakerOn }).then(function (r) {
            if (r.success) {
                if (typeof api !== 'undefined') api.showToast('Speaker ' + (speakerOn ? 'ON' : 'OFF'), 'success');
                updateOverlay();
            } else {
                speakerOn = !speakerOn;
                if (typeof api !== 'undefined') api.showToast('Speaker failed', 'error');
            }
        }).catch(function () {
            speakerOn = !speakerOn;
            if (typeof api !== 'undefined') api.showToast('Speaker failed', 'error');
        });
    };

    window._cnDismiss = function () {
        var stateKey = callState + ':' + (callerNumber || '') + ':' + (callerName || '');
        dismissedForState = stateKey;
        overlay.classList.remove('visible');
    };

    // ---- Start ----
    init();
})();
