/**
 * SmartUI — Remote Accessibility Node Interaction (Screenshot Overlay Version)
 * 
 * Reusable popup that reads the device's accessibility UI tree,
 * captures a screenshot, and overlays clickable node rectangles.
 * Looks like a mini screen share — user can see the actual screen
 * and click any element remotely.
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
    let liveWs = null;

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

    function createOverlay() {
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'smart-ui-overlay';
        overlay.innerHTML = `
            <style>
                #smart-ui-overlay {
                    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.8); backdrop-filter: blur(8px);
                    z-index: 99999; display: flex; align-items: center; justify-content: center;
                    font-family: 'Inter', -apple-system, sans-serif;
                    animation: suiFadeIn 0.2s ease;
                }
                @keyframes suiFadeIn { from { opacity:0 } to { opacity:1 } }

                .sui-popup {
                    display: flex; flex-direction: column; align-items: center;
                    max-height: 95vh; max-width: 95vw;
                }

                /* Header */
                .sui-popup-header {
                    display: flex; align-items: center; gap: 12px;
                    padding: 8px 14px; width: 100%;
                    background: rgba(15,20,35,0.95); border: 1px solid rgba(0,230,118,0.15);
                    border-radius: 10px 10px 0 0;
                }
                .sui-popup-title { color: #00e676; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; flex: 1; }
                .sui-popup-status { color: rgba(255,255,255,0.4); font-size: 10px; }
                .sui-popup-close {
                    background: rgba(255,255,255,0.06); border: none; color: #aaa;
                    width: 26px; height: 26px; border-radius: 6px; cursor: pointer;
                    font-size: 12px; display: flex; align-items: center; justify-content: center;
                }
                .sui-popup-close:hover { background: rgba(255,0,0,0.15); color: #ff5252; }

                /* Phone frame */
                .sui-phone-frame {
                    position: relative; border-left: 2px solid rgba(0,230,118,0.15);
                    border-right: 2px solid rgba(0,230,118,0.15);
                    overflow: hidden; background: #000;
                    box-shadow: 0 0 40px rgba(0,0,0,0.6), 0 0 4px rgba(0,230,118,0.1);
                }
                .sui-phone-screen {
                    position: relative; width: 100%; height: 100%; overflow: hidden;
                }
                .sui-phone-screen img {
                    display: block; width: 100%; height: 100%;
                }
                .sui-placeholder {
                    display: flex; align-items: center; justify-content: center;
                    flex-direction: column; color: rgba(255,255,255,0.3);
                    font-size: 12px; padding: 40px; text-align: center;
                    width: 260px; height: 520px;
                }
                .sui-placeholder .icon { font-size: 32px; margin-bottom: 8px; opacity: 0.4; }

                /* Shimmer loading */
                .sui-phone-frame.loading::after {
                    content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                    background: linear-gradient(90deg, transparent 30%, rgba(0,255,65,0.04) 50%, transparent 70%);
                    animation: suiShimmer 1.5s infinite; pointer-events: none; z-index: 10;
                }
                @keyframes suiShimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

                /* Node overlay */
                .sui-node-overlay {
                    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                    pointer-events: none;
                }
                .sui-node-rect {
                    position: absolute; border: 1px solid transparent;
                    cursor: pointer; pointer-events: auto; transition: all 0.1s; z-index: 2;
                }
                .sui-node-rect:hover {
                    border-color: #00e676; background: rgba(0,255,65,0.12);
                    box-shadow: 0 0 8px rgba(0,255,65,0.3);
                }
                .sui-node-rect.clicking {
                    background: rgba(0,255,65,0.3); border-color: #00e676;
                }
                .sui-node-tip {
                    display: none; position: absolute; bottom: calc(100% + 3px);
                    left: 50%; transform: translateX(-50%);
                    background: rgba(15,20,35,0.95); border: 1px solid rgba(0,230,118,0.3);
                    border-radius: 4px; padding: 2px 7px; font-size: 9px;
                    color: #00e676; white-space: nowrap; z-index: 100; pointer-events: none;
                }
                .sui-node-rect:hover .sui-node-tip { display: block; }

                /* Footer nav */
                .sui-popup-footer {
                    display: flex; align-items: center; gap: 4px;
                    padding: 6px 10px; width: 100%;
                    background: rgba(15,20,35,0.95); border: 1px solid rgba(0,230,118,0.15);
                    border-radius: 0 0 10px 10px; justify-content: center;
                }
                .sui-fbtn {
                    padding: 5px 10px; border-radius: 5px; font-size: 10px; font-weight: 600;
                    cursor: pointer; border: 1px solid rgba(255,255,255,0.08);
                    background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.5);
                    font-family: 'Inter', sans-serif; transition: all 0.12s;
                }
                .sui-fbtn:hover { color: #fff; border-color: rgba(255,255,255,0.15); }
                .sui-fbtn-primary {
                    background: rgba(0,230,118,0.1); border-color: rgba(0,230,118,0.2);
                    color: #00e676;
                }
                .sui-fbtn-primary:hover { background: rgba(0,230,118,0.2); }
                .sui-popup-info {
                    margin-left: auto; color: rgba(255,255,255,0.25); font-size: 9px;
                }
            </style>
            <div class="sui-popup">
                <div class="sui-popup-header">
                    <div class="sui-popup-title">${escHtml(opts.title || 'SMART UI CONTROLLER')}</div>
                    <span class="sui-popup-status" id="sui-status">Loading...</span>
                    <button class="sui-popup-close" onclick="SmartUI.close()">✕</button>
                </div>
                <div class="sui-phone-frame loading" id="sui-frame">
                    <div class="sui-phone-screen" id="sui-screen">
                        <div class="sui-placeholder" id="sui-placeholder">
                            <span class="icon">📱</span>
                            <p>Capturing screen...</p>
                        </div>
                        <img id="sui-img" style="display:none;" draggable="false" />
                        <div class="sui-node-overlay" id="sui-overlay"></div>
                    </div>
                </div>
                <div class="sui-popup-footer">
                    <button class="sui-fbtn sui-fbtn-primary" onclick="SmartUI.refresh()">↻ REFRESH</button>
                    <button class="sui-fbtn" onclick="SmartUI.navKey('BACK')">◀ BACK</button>
                    <button class="sui-fbtn" onclick="SmartUI.navKey('HOME')">● HOME</button>
                    <button class="sui-fbtn" onclick="SmartUI.navKey('RECENTS')">▣ RECENTS</button>
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
            if (e.key === 'Escape') { SmartUI.close(); }
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
            if (status) status.textContent = err.message || 'Failed';
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
                if (status) status.textContent = '● LIVE • ' + new Date().toLocaleTimeString();

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
            if (status) status.textContent = err.message || 'Screenshot failed';
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
        },

        close() {
            if (overlay) {
                document.removeEventListener('keydown', overlay._escHandler);
                overlay.remove();
                overlay = null;
            }
            allNodes = [];
            if (ssBlobUrl) { URL.revokeObjectURL(ssBlobUrl); ssBlobUrl = null; }
            if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
            if (liveWs) { try { liveWs.close(); } catch (e) { } liveWs = null; }
            if (opts.onClose) opts.onClose();
        },

        refresh() {
            fetchTree();
        },

        filter() {
            // Not used in screenshot mode
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
