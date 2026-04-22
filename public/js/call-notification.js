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
    var DISMISS_KEY = 'cn_dismissed_state';
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
    var bc = null;

    try { dismissedForState = sessionStorage.getItem(DISMISS_KEY) || null; } catch (e) { }

    // ---- SVG Icons ----
    var ICO = {
        phoneIncoming: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 2 16 8 22 8"/><line x1="23" y1="1" x2="16" y2="8"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
        phoneCall: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
        phoneOff: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>',
        volume: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
        smartphone: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
        monitor: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
        x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    };

    // ---- Inject CSS ----
    var style = document.createElement('style');
    style.textContent = `
        #call-notify-overlay {
            position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
            display: none; padding: 0 12px;
            pointer-events: none;
        }
        #call-notify-overlay.visible {
            display: block;
            animation: cnSlideIn 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #call-notify-inner {
            max-width: 520px; margin: 16px auto; padding: 14px 18px;
            border-radius: 12px; pointer-events: auto;
            display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
            font-family: 'Satoshi', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: rgba(10, 14, 23, 0.94);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(0, 255, 65, 0.12);
            box-sizing: border-box;
        }
        #call-notify-inner * { box-sizing: border-box; }

        #call-notify-inner.cn-ringing {
            border-color: rgba(0, 255, 65, 0.3);
            animation: cnPulse 2s ease-in-out infinite;
        }
        #call-notify-inner.cn-active {
            border-color: rgba(0, 255, 65, 0.2);
        }

        .cn-icon-wrap {
            width: 40px; height: 40px;
            display: flex; align-items: center; justify-content: center;
            border-radius: 10px;
            flex-shrink: 0;
        }
        .cn-ringing .cn-icon-wrap {
            background: linear-gradient(135deg, rgba(0, 255, 65, 0.15), rgba(0, 255, 65, 0.05));
            border: 1px solid rgba(0, 255, 65, 0.25);
            color: #00ff41;
        }
        .cn-active .cn-icon-wrap {
            background: linear-gradient(135deg, rgba(0, 255, 65, 0.1), rgba(0, 255, 65, 0.03));
            border: 1px solid rgba(0, 255, 65, 0.2);
            color: #00ff41;
        }

        .cn-info { flex: 1; min-width: 100px; }
        .cn-label {
            font-size: 0.55rem; font-weight: 600;
            text-transform: uppercase; letter-spacing: 1.5px;
            color: rgba(0, 255, 65, 0.5);
        }
        .cn-number {
            font-size: 0.85rem; font-weight: 700;
            margin-top: 2px; color: #e0e0e0;
            word-break: break-all;
        }
        .cn-number span { color: rgba(255, 255, 255, 0.4); font-weight: 500; }

        .cn-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .cn-btn {
            border: 1px solid transparent; padding: 7px 12px;
            border-radius: 6px; cursor: pointer;
            font-weight: 600; font-size: 0.58rem; text-transform: uppercase;
            letter-spacing: 0.5px; transition: all 0.15s;
            font-family: 'Satoshi', -apple-system, BlinkMacSystemFont, sans-serif;
            display: inline-flex; align-items: center; gap: 5px;
            white-space: nowrap;
        }
        .cn-btn:hover { transform: translateY(-1px); }
        .cn-btn:active { transform: scale(0.96); }

        .cn-btn-answer {
            background: rgba(0, 255, 65, 0.1);
            border-color: rgba(0, 255, 65, 0.2);
            color: #00ff41;
        }
        .cn-btn-answer:hover {
            background: rgba(0, 255, 65, 0.18);
            box-shadow: 0 0 12px rgba(0, 255, 65, 0.1);
        }

        .cn-btn-answer-mobile {
            background: rgba(0, 170, 255, 0.1);
            border-color: rgba(0, 170, 255, 0.2);
            color: #00aaff;
        }
        .cn-btn-answer-mobile:hover {
            background: rgba(0, 170, 255, 0.18);
            box-shadow: 0 0 12px rgba(0, 170, 255, 0.1);
        }

        .cn-btn-reject, .cn-btn-end {
            background: rgba(255, 51, 51, 0.1);
            border-color: rgba(255, 51, 51, 0.2);
            color: #ff5252;
        }
        .cn-btn-reject:hover, .cn-btn-end:hover {
            background: rgba(255, 51, 51, 0.18);
            box-shadow: 0 0 12px rgba(255, 51, 51, 0.1);
        }

        .cn-btn-speaker {
            background: rgba(0, 170, 255, 0.08);
            border-color: rgba(0, 170, 255, 0.15);
            color: rgba(0, 170, 255, 0.7);
        }
        .cn-btn-speaker:hover {
            background: rgba(0, 170, 255, 0.15);
            color: #00aaff;
        }
        .cn-btn-speaker.on {
            background: rgba(255, 170, 0, 0.12);
            border-color: rgba(255, 170, 0, 0.25);
            color: #ffaa00;
        }
        .cn-btn-speaker.on:hover {
            background: rgba(255, 170, 0, 0.2);
        }

        .cn-dismiss {
            background: none;
            border: 1px solid rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.3);
            cursor: pointer;
            padding: 6px;
            line-height: 1;
            border-radius: 6px;
            transition: all 0.15s;
            flex-shrink: 0;
            margin-left: auto;
            display: flex; align-items: center; justify-content: center;
        }
        .cn-dismiss:hover {
            color: #ff5252;
            background: rgba(255, 51, 51, 0.08);
            border-color: rgba(255, 51, 51, 0.2);
        }

        @keyframes cnPulse {
            0%, 100% { box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), 0 0 0 0 rgba(0, 255, 65, 0.05); }
            50% { box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), 0 0 20px 2px rgba(0, 255, 65, 0.08); }
        }
        @keyframes cnSlideIn {
            from { transform: translateY(-100%); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        @media (max-width: 480px) {
            #call-notify-inner { padding: 10px 12px; gap: 10px; }
            .cn-icon-wrap { width: 34px; height: 34px; }
            .cn-icon-wrap svg { width: 16px; height: 16px; }
            .cn-number { font-size: 0.78rem; }
            .cn-btn { padding: 6px 10px; font-size: 0.52rem; }
            .cn-actions { width: 100%; }
            .cn-actions .cn-btn { flex: 1 1 45%; text-align: center; min-width: 0; justify-content: center; }
        }
    `;
    document.head.appendChild(style);

    // ---- Inject overlay HTML ----
    overlay = document.createElement('div');
    overlay.id = 'call-notify-overlay';
    overlay.innerHTML =
        '<div id="call-notify-inner">' +
        '<div class="cn-icon-wrap" id="cn-icon"></div>' +
        '<div class="cn-info">' +
        '<div class="cn-label" id="cn-label"></div>' +
        '<div class="cn-number" id="cn-number"></div>' +
        '</div>' +
        '<div class="cn-actions" id="cn-actions"></div>' +
        '<button class="cn-dismiss" onclick="window._cnDismiss()" title="Dismiss">' + ICO.x + '</button>' +
        '</div>';
    document.body.appendChild(overlay);

    // ---- BroadcastChannel (cross-tab instant sync) ----
    try {
        bc = new BroadcastChannel(BC_NAME);
        bc.onmessage = function (e) {
            if (e.data && e.data.type === 'call_state_update') {
                _applyLocal(e.data.state, e.data.number, e.data.name);
            }
            if (e.data && e.data.type === 'call_dismissed') {
                dismissedForState = e.data.stateKey;
                try { sessionStorage.setItem(DISMISS_KEY, dismissedForState); } catch (e) { }
                updateOverlay();
            }
        };
    } catch (e) { bc = null; }

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

        var saved = loadState();
        if (saved && saved.state && saved.state !== 'IDLE') {
            _applyLocal(saved.state, saved.number, saved.name);
        }

        if (deviceId) {
            startNotifications();
            return;
        }

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

        pollCurrentState();

        setInterval(function () {
            if (callState !== 'IDLE') pollCurrentState();
        }, 5000);

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

    // ---- Apply state (saves + broadcasts) ----
    function applyState(newState, newNumber, newName) {
        if (newState === callState && newNumber === callerNumber && newName === callerName) return;
        console.log('[CallNotify] State:', newState, newNumber, newName);
        saveState(newState, newNumber, newName);
        if (bc) {
            try { bc.postMessage({ type: 'call_state_update', state: newState, number: newNumber, name: newName }); } catch (e) { }
        }
        _applyLocal(newState, newNumber, newName);
    }

    // ---- Apply state locally only ----
    function _applyLocal(newState, newNumber, newName) {
        var oldState = callState;
        callState = newState;
        callerNumber = newNumber;
        callerName = newName;

        var newKey = newState + ':' + (newNumber || '') + ':' + (newName || '');
        if (newState !== oldState && dismissedForState !== newKey) {
            dismissedForState = null;
            try { sessionStorage.removeItem(DISMISS_KEY); } catch (e) { }
        }

        if (newState === 'IDLE') {
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) { }
        }

        updateOverlay();
    }

    function esc(str) {
        if (!str) return '';
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
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
            icon.innerHTML = ICO.phoneIncoming;
            label.textContent = 'Incoming Call';
            num.innerHTML = callerName
                ? esc(callerName) + ' <span>(' + esc(callerNumber) + ')</span>'
                : esc(callerNumber || 'Unknown');
            actions.innerHTML =
                '<button class="cn-btn cn-btn-answer-mobile" onclick="window._cnAnswerOnMobile()">' + ICO.smartphone + ' On Mobile</button>' +
                '<button class="cn-btn cn-btn-answer" onclick="window._cnAnswer()">' + ICO.monitor + ' Dashboard</button>' +
                '<button class="cn-btn cn-btn-reject" onclick="window._cnReject()">' + ICO.phoneOff + ' Reject</button>';

        } else if (callState === 'OFFHOOK') {
            if (dismissedForState === stateKey) { overlay.classList.remove('visible'); return; }
            overlay.classList.add('visible');
            inner.className = 'cn-active';
            icon.innerHTML = ICO.phoneCall;
            label.textContent = 'Call Active';
            num.innerHTML = callerName
                ? esc(callerName) + ' <span>(' + esc(callerNumber) + ')</span>'
                : esc(callerNumber || 'On Call');
            var spkClass = speakerOn ? 'cn-btn cn-btn-speaker on' : 'cn-btn cn-btn-speaker';
            actions.innerHTML =
                '<button class="' + spkClass + '" onclick="window._cnSpeaker()">' + ICO.volume + ' ' + (speakerOn ? 'Speaker On' : 'Speaker') + '</button>' +
                '<button class="cn-btn cn-btn-end" onclick="window._cnEnd()">' + ICO.phoneOff + ' End</button>';

        } else {
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
        if (typeof api !== 'undefined') api.showToast('Answer the call on your mobile device', 'info');
        var stateKey = callState + ':' + (callerNumber || '') + ':' + (callerName || '');
        dismissedForState = stateKey;
        try { sessionStorage.setItem(DISMISS_KEY, stateKey); } catch (e) { }
        overlay.classList.remove('visible');
        if (bc) {
            try { bc.postMessage({ type: 'call_dismissed', stateKey: stateKey }); } catch (e) { }
        }
    };

    window._cnAnswer = function () {
        // Step 1: Answer the call
        sendCallAction('call_answer').then(function (r) {
            if (r.success) {
                if (typeof api !== 'undefined') api.showToast('Call answered — enabling speaker + mic stream...', 'success');
                // Step 2: Enable speaker (wait 500ms for call to connect)
                setTimeout(function () {
                    speakerOn = true;
                    sendCallAction('call_speaker', { on: true }).then(function () {
                        // Step 3: Redirect to mic-stream page to hear both sides
                        setTimeout(function () {
                            window.location.href = '/mic-stream.html?deviceId=' + encodeURIComponent(deviceId) + '&autoStart=true';
                        }, 300);
                    }).catch(function () {
                        // Speaker failed, still redirect to mic stream
                        window.location.href = '/mic-stream.html?deviceId=' + encodeURIComponent(deviceId) + '&autoStart=true';
                    });
                }, 500);
            } else {
                if (typeof api !== 'undefined') api.showToast('Answer failed: ' + (r.error || 'unknown'), 'error');
            }
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
        try { sessionStorage.setItem(DISMISS_KEY, stateKey); } catch (e) { }
        overlay.classList.remove('visible');
        if (bc) {
            try { bc.postMessage({ type: 'call_dismissed', stateKey: stateKey }); } catch (e) { }
        }
    };

    // ---- Start ----
    init();
})();
