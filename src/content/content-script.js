/**
 * NyandSign — Content Script
 *
 * Service Worker から受信したアクションを
 * ページ内の動画/音声要素やスクロールに適用する。
 */

(() => {
    'use strict';
    if (globalThis.__nyandsignContentScriptLoaded) {
        globalThis.__nyandsignRefreshFrameRegistration?.();
        return;
    }
    globalThis.__nyandsignContentScriptLoaded = true;

    /**
     * ページ内で最も適切なメディア要素を取得する。
     * 優先順: 再生中 > 一時停止中 > 最後の要素
     * YouTube などの SPA は動的に要素を生成するため毎回検索する。
     */
    function findBestMediaElement() {
        const all = [...document.querySelectorAll('video, audio')];
        if (all.length === 0) return null;

        // 再生中の要素を優先
        const playing = all.find(el => !el.paused && !el.ended && el.readyState > 2);
        if (playing) return playing;

        // 一時停止中の要素
        const paused = all.find(el => el.paused && el.readyState > 0);
        if (paused) return paused;

        // どれでも
        return all[0];
    }

    /**
     * YouTube 固有の操作ヘルパー
     */
    function isYouTube() {
        return location.hostname.includes('youtube.com');
    }

    function youtubeNavigate(direction) {
        // YouTube の次/前トラックはキーボードイベントで操作
        if (direction === 'next') {
            const btn = document.querySelector('.ytp-next-button');
            if (btn) { btn.click(); return true; }
        } else if (direction === 'prev') {
            const btn = document.querySelector('.ytp-prev-button');
            if (btn) { btn.click(); return true; }
        }
        return false;
    }

    const BROWSER_PAGE_ACTIONS = new Set([
        'directionalScroll', 'scrollDown', 'scrollUp', 'scrollRight', 'scrollLeft', 'pageTop', 'pageBottom',
        'cursorUp', 'cursorDown', 'cursorLeft', 'cursorRight',
        'pointerShow', 'pointerHide', 'pointerMoveStart', 'pointerMoveEnd', 'pointerMove', 'pointerClick', 'pointerClickAt', 'pointerTargetAt',
    ]);

    const CURSOR_KEY_BY_ACTION = {
        cursorUp: 'ArrowUp',
        cursorDown: 'ArrowDown',
        cursorLeft: 'ArrowLeft',
        cursorRight: 'ArrowRight',
    };

    const KEY_CODE_BY_KEY = {
        ArrowUp: 38,
        ArrowDown: 40,
        ArrowLeft: 37,
        ArrowRight: 39,
    };

    const CURSOR_DIRECTION_BY_ACTION = {
        cursorUp: 'up',
        cursorDown: 'down',
        cursorLeft: 'left',
        cursorRight: 'right',
    };

    const FRAME_MESSAGE_SOURCE = 'nyandsign-frame-route';
    const FRAME_SELECTOR = 'iframe, frame';
    const SCROLL_ACTIONS = new Set([
        'directionalScroll', 'scrollDown', 'scrollUp', 'scrollRight', 'scrollLeft', 'pageTop', 'pageBottom',
    ]);
    const POINTER_TOP_ACTIONS = new Set([
        'pointerShow', 'pointerHide', 'pointerMoveStart', 'pointerMoveEnd', 'pointerMove', 'pointerClick',
    ]);

    let framePath = null;
    let lastFocusedDescendantPath = null;
    let assignChildrenTimer = null;
    let assignChildrenRetryTimer = null;
    let assignChildrenLateTimer = null;
    let framePathRequestTimer = null;
    let framePathRequestAttempts = 0;

    function getFocusedEditable() {
        const el = document.activeElement;
        if (!el) return null;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) return el;
        return null;
    }

    function getScrollRoot() {
        return document.scrollingElement || document.documentElement || document.body;
    }

    function isTopFrame() {
        return window.top === window;
    }

    function normalizeFramePath(path) {
        if (!Array.isArray(path)) return null;
        const result = [];
        for (const value of path) {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0) return null;
            result.push(n);
        }
        return result;
    }

    function sameFramePath(a, b) {
        const left = normalizeFramePath(a);
        const right = normalizeFramePath(b);
        if (!left || !right || left.length !== right.length) return false;
        return left.every((value, index) => value === right[index]);
    }

    function isDescendantFramePath(path, base = framePath) {
        const target = normalizeFramePath(path);
        const parent = normalizeFramePath(base);
        if (!target || !parent || target.length <= parent.length) return false;
        return parent.every((value, index) => target[index] === value);
    }

    function frameElements() {
        return [...document.querySelectorAll(FRAME_SELECTOR)];
    }

    function isFrameElement(el) {
        return el instanceof HTMLIFrameElement ||
            (typeof HTMLFrameElement === 'function' && el instanceof HTMLFrameElement);
    }

    function visibleFrameElement(el) {
        if (!isFrameElement(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
            rect.bottom >= 0 && rect.top <= window.innerHeight &&
            rect.right >= 0 && rect.left <= window.innerWidth;
    }

    function framePathForElement(el) {
        if (!framePath || !isFrameElement(el)) return null;
        const index = frameElements().indexOf(el);
        return index >= 0 ? [...framePath, index] : null;
    }

    function directFrameForPath(path) {
        if (!framePath || !isDescendantFramePath(path)) return null;
        const target = normalizeFramePath(path);
        const nextIndex = target[framePath.length];
        const el = frameElements()[nextIndex];
        return visibleFrameElement(el) ? el : null;
    }

    function postToFrameElement(el, message) {
        try {
            el.contentWindow?.postMessage(message, '*');
            return true;
        } catch (_) {
            return false;
        }
    }

    function registerFrame() {
        if (!framePath) return;
        chrome.runtime.sendMessage({
            type: 'register-content-frame',
            framePath,
        }).catch(() => {});
    }

    function assignChildFramePaths() {
        if (!framePath) return;
        frameElements().forEach((el, index) => {
            postToFrameElement(el, {
                source: FRAME_MESSAGE_SOURCE,
                type: 'assign-frame-path',
                framePath: [...framePath, index],
            });
        });
    }

    function scheduleAssignChildFramePaths() {
        if (assignChildrenTimer) clearTimeout(assignChildrenTimer);
        if (assignChildrenRetryTimer) clearTimeout(assignChildrenRetryTimer);
        if (assignChildrenLateTimer) clearTimeout(assignChildrenLateTimer);
        assignChildrenTimer = setTimeout(() => {
            assignChildrenTimer = null;
            assignChildFramePaths();
        }, 0);
        assignChildrenRetryTimer = setTimeout(assignChildFramePaths, 250);
        assignChildrenLateTimer = setTimeout(assignChildFramePaths, 1000);
    }

    function setFramePath(path) {
        const normalizedPath = normalizeFramePath(path);
        if (!normalizedPath) return;
        if (framePathRequestTimer) {
            clearInterval(framePathRequestTimer);
            framePathRequestTimer = null;
        }
        if (sameFramePath(framePath, normalizedPath)) {
            registerFrame();
            scheduleAssignChildFramePaths();
            return;
        }
        framePath = normalizedPath;
        lastFocusedDescendantPath = null;
        registerFrame();
        scheduleAssignChildFramePaths();
    }

    function refreshFrameRegistration() {
        if (framePath) {
            registerFrame();
            scheduleAssignChildFramePaths();
        } else {
            startFramePathRequests();
        }
    }

    globalThis.__nyandsignRefreshFrameRegistration = refreshFrameRegistration;

    function findFrameElementByWindow(sourceWindow) {
        return frameElements().find((el) => {
            try {
                return el.contentWindow === sourceWindow;
            } catch (_) {
                return false;
            }
        }) || null;
    }

    function rememberFocusedFramePath(path) {
        const normalizedPath = normalizeFramePath(path);
        if (!normalizedPath || !framePath) return;

        lastFocusedDescendantPath = isDescendantFramePath(normalizedPath)
            ? normalizedPath
            : null;

        if (!isTopFrame()) {
            try {
                window.parent.postMessage({
                    source: FRAME_MESSAGE_SOURCE,
                    type: 'focused-frame',
                    framePath: normalizedPath,
                }, '*');
            } catch (_) {}
        }
    }

    function reportThisFrameFocused() {
        if (framePath) rememberFocusedFramePath(framePath);
    }

    function handleFrameMessage(event) {
        const data = event.data;
        if (!data || data.source !== FRAME_MESSAGE_SOURCE) return;

        if (data.type === 'assign-frame-path') {
            if (event.source === window.parent) setFramePath(data.framePath);
            return;
        }

        if (data.type === 'request-frame-path') {
            const el = findFrameElementByWindow(event.source);
            const childPath = framePathForElement(el);
            if (el && childPath) {
                postToFrameElement(el, {
                    source: FRAME_MESSAGE_SOURCE,
                    type: 'assign-frame-path',
                    framePath: childPath,
                });
            }
            return;
        }

        if (data.type === 'focused-frame') {
            const el = findFrameElementByWindow(event.source);
            const childPath = framePathForElement(el);
            const focusedPath = normalizeFramePath(data.framePath);
            if (childPath && focusedPath && (
                sameFramePath(focusedPath, childPath) ||
                isDescendantFramePath(focusedPath, childPath)
            )) {
                rememberFocusedFramePath(focusedPath);
            }
        }
    }

    function requestFramePath() {
        if (isTopFrame()) return;
        try {
            window.parent.postMessage({
                source: FRAME_MESSAGE_SOURCE,
                type: 'request-frame-path',
            }, '*');
        } catch (_) {}
    }

    function startFramePathRequests() {
        requestFramePath();
        if (framePathRequestTimer) clearInterval(framePathRequestTimer);
        framePathRequestAttempts = 0;
        framePathRequestTimer = setInterval(() => {
            if (framePath || framePathRequestAttempts >= 20) {
                clearInterval(framePathRequestTimer);
                framePathRequestTimer = null;
                return;
            }
            framePathRequestAttempts += 1;
            requestFramePath();
        }, 500);
    }

    function activeDirectFramePath() {
        const el = document.activeElement;
        return visibleFrameElement(el) ? framePathForElement(el) : null;
    }

    function resolveFocusedTargetFramePath() {
        const activePath = activeDirectFramePath();
        if (activePath) return activePath;

        if (lastFocusedDescendantPath && directFrameForPath(lastFocusedDescendantPath)) {
            return lastFocusedDescendantPath;
        }
        return null;
    }

    async function routeFrameAction(targetFramePath, action, data = {}) {
        const normalizedPath = normalizeFramePath(targetFramePath);
        if (!normalizedPath) return { ok: false, reason: 'frameActionUnavailable' };

        try {
            return await chrome.runtime.sendMessage({
                type: 'route-frame-action',
                framePath: normalizedPath,
                action,
                data,
            });
        } catch (err) {
            return {
                ok: false,
                reason: 'frameActionUnavailable',
                message: err?.message || String(err),
            };
        }
    }

    function plainRect(rect) {
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
    }

    function translateRect(rect, offsetLeft, offsetTop) {
        if (!rect) return null;
        return {
            left: Number(rect.left) + offsetLeft,
            top: Number(rect.top) + offsetTop,
            width: Number(rect.width),
            height: Number(rect.height),
        };
    }

    function isScrollable(el, axis, allowVisible = false) {
        if (!el) return false;
        const scrollSize = axis === 'x' ? el.scrollWidth : el.scrollHeight;
        const clientSize = axis === 'x' ? el.clientWidth : el.clientHeight;
        if (scrollSize <= clientSize + 8) return false;

        const style = getComputedStyle(el);
        const overflow = axis === 'x' ? style.overflowX : style.overflowY;
        return ['auto', 'scroll', 'overlay'].includes(overflow) || (allowVisible && overflow === 'visible');
    }

    function findScrollableElement(axis) {
        const root = getScrollRoot();
        if (isScrollable(root, axis, true)) return root;

        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const underPointer = document.elementsFromPoint(centerX, centerY);
        for (const el of underPointer) {
            if (isScrollable(el, axis)) return el;
        }

        let best = null;
        let bestArea = 0;
        for (const el of document.querySelectorAll('*')) {
            if (!isScrollable(el, axis)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
            if (rect.right < 0 || rect.left > window.innerWidth) continue;
            const area = rect.width * rect.height;
            if (area > bestArea) {
                best = el;
                bestArea = area;
            }
        }
        return best || root;
    }

    function scrollPageBy(left, top, smooth = true) {
        const behavior = smooth ? 'smooth' : 'auto';
        if (top) findScrollableElement('y').scrollBy({ top, behavior });
        if (left) findScrollableElement('x').scrollBy({ left, behavior });
    }

    function executeLocalScrollAction(action, data = {}) {
        switch (action) {
            case 'directionalScroll':
                scrollPageBy(Number(data.left) || 0, Number(data.top) || 0, false);
                return true;
            case 'scrollDown':
                scrollPageBy(0, Math.round(window.innerHeight * 0.55));
                return true;
            case 'scrollUp':
                scrollPageBy(0, -Math.round(window.innerHeight * 0.55));
                return true;
            case 'scrollRight':
                scrollPageBy(Math.round(window.innerWidth * 0.55), 0);
                return true;
            case 'scrollLeft':
                scrollPageBy(-Math.round(window.innerWidth * 0.55), 0);
                return true;
            case 'pageTop':
                findScrollableElement('y').scrollTo({ top: 0, behavior: 'smooth' });
                return true;
            case 'pageBottom':
                {
                    const scroller = findScrollableElement('y');
                    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
                }
                return true;
            default:
                return false;
        }
    }

    async function executeTargetedScrollAction(action, data = {}) {
        const targetFramePath = resolveFocusedTargetFramePath();
        if (targetFramePath && !sameFramePath(targetFramePath, framePath)) {
            const result = await routeFrameAction(targetFramePath, action, data);
            if (result?.ok) return { ok: true, overlay: false };
        }

        executeLocalScrollAction(action, data);
        return { ok: true, overlay: true };
    }

    function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
    }

    const POINTER_EDGE_SCROLL_MIN_OVERFLOW = 2;
    const POINTER_EDGE_SCROLL_SCALE = 1.2;
    const POINTER_EDGE_SCROLL_MAX_STEP = 42;

    function pointerEdgeScrollAmount(overflow) {
        if (Math.abs(overflow) < POINTER_EDGE_SCROLL_MIN_OVERFLOW) return 0;
        return Math.round(clamp(overflow * POINTER_EDGE_SCROLL_SCALE, -POINTER_EDGE_SCROLL_MAX_STEP, POINTER_EDGE_SCROLL_MAX_STEP));
    }

    function scrollByPointerOverflow(overflowX, overflowY) {
        const left = pointerEdgeScrollAmount(overflowX);
        const top = pointerEdgeScrollAmount(overflowY);
        if (left || top) scrollPageBy(left, top, false);
    }

    const virtualPointer = {
        x: null,
        y: null,
        cursorEl: null,
        crossEl: null,
        targetEl: null,
        dimTimer: null,
        staleTimer: null,
        moving: false,
        targetQuerySeq: 0,
        targetQueryAt: 0,
        targetQueryPathKey: '',
    };

    function pointerRoot() {
        return document.body || document.documentElement;
    }

    function initPointerPosition() {
        if (typeof virtualPointer.x !== 'number') virtualPointer.x = Math.round(window.innerWidth / 2);
        if (typeof virtualPointer.y !== 'number') virtualPointer.y = Math.round(window.innerHeight / 2);
        virtualPointer.x = clamp(virtualPointer.x, 0, Math.max(0, window.innerWidth - 1));
        virtualPointer.y = clamp(virtualPointer.y, 0, Math.max(0, window.innerHeight - 1));
    }

    function ensureVirtualPointer() {
        initPointerPosition();
        const root = pointerRoot();
        if (!root) return null;

        if (!virtualPointer.cursorEl) {
            const el = document.createElement('div');
            el.id = '__nyand_virtual_pointer';
            Object.assign(el.style, {
                position: 'fixed',
                left: '0',
                top: '0',
                width: '22px',
                height: '22px',
                boxSizing: 'border-box',
                borderRadius: '50%',
                border: '2px solid rgba(255, 193, 7, 0.95)',
                background: 'rgba(255, 193, 7, 0.24)',
                boxShadow: '0 0 0 4px rgba(0, 0, 0, 0.28), 0 0 18px rgba(255, 193, 7, 0.55)',
                pointerEvents: 'none',
                zIndex: '2147483647',
                transform: 'translate(-50%, -50%) scale(1)',
                opacity: '0.38',
                transition: 'opacity 0.2s ease, transform 0.12s ease, border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease',
            });
            const cross = document.createElement('div');
            cross.id = '__nyand_virtual_pointer_cross';
            Object.assign(cross.style, {
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: '11px',
                height: '11px',
                transform: 'translate(-50%, -50%)',
                background: [
                    'linear-gradient(rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.98)) center / 11px 2px no-repeat',
                    'linear-gradient(rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.98)) center / 2px 11px no-repeat',
                ].join(', '),
                filter: 'drop-shadow(0 0 2px rgba(0, 0, 0, 0.65))',
                opacity: '0',
                transition: 'opacity 0.12s ease',
            });
            el.appendChild(cross);
            root.appendChild(el);
            virtualPointer.cursorEl = el;
            virtualPointer.crossEl = cross;
        }

        if (!virtualPointer.targetEl) {
            const el = document.createElement('div');
            el.id = '__nyand_pointer_target';
            Object.assign(el.style, {
                position: 'fixed',
                left: '0',
                top: '0',
                width: '0',
                height: '0',
                border: '2px solid rgba(255, 193, 7, 0.85)',
                borderRadius: '6px',
                boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.22)',
                pointerEvents: 'none',
                zIndex: '2147483646',
                opacity: '0',
                transition: 'opacity 0.15s ease, left 0.08s ease, top 0.08s ease, width 0.08s ease, height 0.08s ease',
            });
            root.appendChild(el);
            virtualPointer.targetEl = el;
        }

        return virtualPointer.cursorEl;
    }

    function pointerTargetAtCurrentPosition() {
        initPointerPosition();
        return document.elementFromPoint(virtualPointer.x, virtualPointer.y);
    }

    function hidePointerTarget() {
        if (virtualPointer.targetEl) {
            virtualPointer.targetEl.style.opacity = '0';
        }
    }

    function applyPointerTargetRect(rect, active = false) {
        if (!virtualPointer.targetEl || !rect) return;
        const width = Number(rect.width) || 0;
        const height = Number(rect.height) || 0;
        if (width <= 0 || height <= 0) {
            hidePointerTarget();
            return;
        }

        Object.assign(virtualPointer.targetEl.style, {
            left: `${Math.max(0, Number(rect.left) - 3)}px`,
            top: `${Math.max(0, Number(rect.top) - 3)}px`,
            width: `${Math.min(window.innerWidth, width + 6)}px`,
            height: `${Math.min(window.innerHeight, height + 6)}px`,
            opacity: active ? '0.85' : '0.35',
        });
    }

    async function describePointerTargetAt(x, y) {
        const target = document.elementFromPoint(x, y);
        if (!target || target === document.documentElement || target === document.body) {
            return { ok: true, targetRect: null };
        }

        if (visibleFrameElement(target)) {
            const childPath = framePathForElement(target);
            const rect = target.getBoundingClientRect();
            if (childPath) {
                const result = await routeFrameAction(childPath, 'pointerTargetAt', {
                    x: clamp(x - rect.left, 0, Math.max(0, rect.width - 1)),
                    y: clamp(y - rect.top, 0, Math.max(0, rect.height - 1)),
                });
                if (result?.targetRect) {
                    return {
                        ok: true,
                        targetRect: translateRect(result.targetRect, rect.left, rect.top),
                        targetFramePath: result.targetFramePath || childPath,
                    };
                }
            }
            return {
                ok: true,
                targetRect: plainRect(rect),
                targetFramePath: childPath,
            };
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { ok: true, targetRect: null };
        return {
            ok: true,
            targetRect: plainRect(rect),
            targetFramePath: framePath || [],
        };
    }

    async function updatePointerTargetFromFrame(frameEl, x, y, active, fallbackRect) {
        const childPath = framePathForElement(frameEl);
        if (!childPath) return;

        const rect = frameEl.getBoundingClientRect();
        const pathKey = JSON.stringify(childPath);
        const now = performance.now();
        if (
            virtualPointer.targetQueryPathKey === pathKey &&
            now - virtualPointer.targetQueryAt < 80
        ) {
            return;
        }
        virtualPointer.targetQueryPathKey = pathKey;
        virtualPointer.targetQueryAt = now;
        const seq = ++virtualPointer.targetQuerySeq;

        const result = await routeFrameAction(childPath, 'pointerTargetAt', {
            x: clamp(x - rect.left, 0, Math.max(0, rect.width - 1)),
            y: clamp(y - rect.top, 0, Math.max(0, rect.height - 1)),
        });

        if (seq !== virtualPointer.targetQuerySeq) return;
        if (result?.targetRect) {
            applyPointerTargetRect(translateRect(result.targetRect, rect.left, rect.top), active);
        } else {
            applyPointerTargetRect(fallbackRect, active);
        }
    }

    function updatePointerTarget(active = false) {
        if (!virtualPointer.targetEl) return;
        const target = pointerTargetAtCurrentPosition();
        if (!target || target === document.documentElement || target === document.body) {
            hidePointerTarget();
            return;
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            hidePointerTarget();
            return;
        }

        const fallbackRect = plainRect(rect);
        applyPointerTargetRect(fallbackRect, active);
        if (visibleFrameElement(target)) {
            updatePointerTargetFromFrame(target, virtualPointer.x, virtualPointer.y, active, fallbackRect).catch(() => {});
        } else {
            virtualPointer.targetQuerySeq += 1;
            virtualPointer.targetQueryPathKey = '';
        }
    }

    function updateVirtualPointer(options = {}) {
        const opts = typeof options === 'boolean' ? { active: options } : options;
        if (typeof opts.moving === 'boolean') virtualPointer.moving = opts.moving;
        const moving = virtualPointer.moving;
        const active = opts.active || moving;
        const el = ensureVirtualPointer();
        if (!el) return;

        initPointerPosition();
        el.style.left = `${virtualPointer.x}px`;
        el.style.top = `${virtualPointer.y}px`;
        el.style.opacity = active ? '0.96' : '0.38';
        el.style.transform = active
            ? 'translate(-50%, -50%) scale(1.12)'
            : 'translate(-50%, -50%) scale(1)';
        el.style.borderColor = moving ? 'rgba(255, 224, 102, 1)' : 'rgba(255, 193, 7, 0.95)';
        el.style.background = moving ? 'rgba(255, 193, 7, 0.38)' : 'rgba(255, 193, 7, 0.24)';
        el.style.boxShadow = moving
            ? '0 0 0 5px rgba(0, 0, 0, 0.34), 0 0 24px rgba(255, 193, 7, 0.72)'
            : '0 0 0 4px rgba(0, 0, 0, 0.28), 0 0 18px rgba(255, 193, 7, 0.55)';
        if (virtualPointer.crossEl) {
            virtualPointer.crossEl.style.opacity = moving ? '0.96' : '0';
        }
        updatePointerTarget(active);

        if (virtualPointer.dimTimer) clearTimeout(virtualPointer.dimTimer);
        virtualPointer.dimTimer = null;
        if (!moving) {
            virtualPointer.dimTimer = setTimeout(() => {
                if (!virtualPointer.cursorEl) return;
                virtualPointer.cursorEl.style.opacity = '0.38';
                virtualPointer.cursorEl.style.transform = 'translate(-50%, -50%) scale(1)';
                updatePointerTarget(false);
            }, 1800);
        }

        if (virtualPointer.staleTimer) clearTimeout(virtualPointer.staleTimer);
        virtualPointer.staleTimer = setTimeout(() => {
            hideVirtualPointer();
        }, 6000);
    }

    function hideVirtualPointer() {
        if (virtualPointer.dimTimer) {
            clearTimeout(virtualPointer.dimTimer);
            virtualPointer.dimTimer = null;
        }
        if (virtualPointer.staleTimer) {
            clearTimeout(virtualPointer.staleTimer);
            virtualPointer.staleTimer = null;
        }
        virtualPointer.cursorEl?.remove();
        virtualPointer.targetEl?.remove();
        virtualPointer.cursorEl = null;
        virtualPointer.crossEl = null;
        virtualPointer.targetEl = null;
        virtualPointer.moving = false;
    }

    function startVirtualPointerMove() {
        updateVirtualPointer({ active: true, moving: true });
    }

    function endVirtualPointerMove() {
        updateVirtualPointer({ active: false, moving: false });
    }

    function moveVirtualPointer(left, top) {
        ensureVirtualPointer();
        const maxX = Math.max(0, window.innerWidth - 1);
        const maxY = Math.max(0, window.innerHeight - 1);
        const currentX = virtualPointer.x ?? window.innerWidth / 2;
        const currentY = virtualPointer.y ?? window.innerHeight / 2;
        const nextX = currentX + left;
        const nextY = currentY + top;
        const clampedX = clamp(nextX, 0, maxX);
        const clampedY = clamp(nextY, 0, maxY);
        const overflowX =
            (currentX <= 0 && nextX < 0) || (currentX >= maxX && nextX > maxX)
                ? nextX - clampedX
                : 0;
        const overflowY =
            (currentY <= 0 && nextY < 0) || (currentY >= maxY && nextY > maxY)
                ? nextY - clampedY
                : 0;

        virtualPointer.x = clampedX;
        virtualPointer.y = clampedY;
        scrollByPointerOverflow(overflowX, overflowY);
        updateVirtualPointer({ active: true, moving: true });
    }

    function createMouseEventAt(type, x, y) {
        return new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: window.screenX + x,
            screenY: window.screenY + y,
            button: 0,
            buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
        });
    }

    async function routePointerClickToFrame(frameEl, x, y) {
        const childPath = framePathForElement(frameEl);
        if (!childPath) return false;

        try {
            if (typeof frameEl.focus === 'function') {
                frameEl.focus({ preventScroll: true });
            }
        } catch (_) {}

        rememberFocusedFramePath(childPath);

        const rect = frameEl.getBoundingClientRect();
        const result = await routeFrameAction(childPath, 'pointerClickAt', {
            x: clamp(x - rect.left, 0, Math.max(0, rect.width - 1)),
            y: clamp(y - rect.top, 0, Math.max(0, rect.height - 1)),
        });
        return result?.ok === true;
    }

    async function clickTargetAt(x, y) {
        const target = document.elementFromPoint(x, y);
        if (!target) return { ok: true, overlay: false };

        if (visibleFrameElement(target)) {
            const routed = await routePointerClickToFrame(target, x, y);
            if (routed) return { ok: true, overlay: false };
        }

        rememberFocusedFramePath(framePath || []);

        try {
            if (typeof target.focus === 'function') {
                target.focus({ preventScroll: true });
            }
        } catch (_) {}

        target.dispatchEvent(createMouseEventAt('mousemove', x, y));
        target.dispatchEvent(createMouseEventAt('mousedown', x, y));
        target.dispatchEvent(createMouseEventAt('mouseup', x, y));
        target.dispatchEvent(createMouseEventAt('click', x, y));
        return { ok: true, overlay: false };
    }

    async function clickVirtualPointerTarget() {
        ensureVirtualPointer();
        const result = await clickTargetAt(virtualPointer.x, virtualPointer.y);
        updateVirtualPointer(true);
        return result;
    }

    function moveTextControlCursor(el, direction) {
        if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return false;

        const value = el.value || '';
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const collapsed = start === end;
        let next = end;

        if (direction === 'left') {
            next = collapsed ? clamp(start - 1, 0, value.length) : start;
        } else if (direction === 'right') {
            next = collapsed ? clamp(end + 1, 0, value.length) : end;
        } else if (direction === 'up') {
            if (el.tagName?.toLowerCase() !== 'textarea') {
                next = 0;
            } else {
                const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                const column = start - lineStart;
                if (lineStart === 0) {
                    next = 0;
                } else {
                    const prevLineEnd = lineStart - 1;
                    const prevLineStart = value.lastIndexOf('\n', prevLineEnd - 1) + 1;
                    next = Math.min(prevLineStart + column, prevLineEnd);
                }
            }
        } else if (direction === 'down') {
            if (el.tagName?.toLowerCase() !== 'textarea') {
                next = value.length;
            } else {
                const lineEnd = value.indexOf('\n', end);
                if (lineEnd < 0) {
                    next = value.length;
                } else {
                    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                    const column = start - lineStart;
                    const nextLineStart = lineEnd + 1;
                    const nextLineEndRaw = value.indexOf('\n', nextLineStart);
                    const nextLineEnd = nextLineEndRaw < 0 ? value.length : nextLineEndRaw;
                    next = Math.min(nextLineStart + column, nextLineEnd);
                }
            }
        }

        el.focus();
        try {
            el.setSelectionRange(next, next);
            return true;
        } catch (_) {
            return false;
        }
    }

    function moveContentEditableCursor(action) {
        const selection = window.getSelection?.();
        if (!selection?.modify) return false;

        const isVertical = action === 'cursorUp' || action === 'cursorDown';
        const direction = (action === 'cursorUp' || action === 'cursorLeft') ? 'backward' : 'forward';
        selection.modify('move', direction, isVertical ? 'line' : 'character');
        return true;
    }

    function createArrowKeyEvent(type, key) {
        const keyCode = KEY_CODE_BY_KEY[key] || 0;
        const event = new KeyboardEvent(type, {
            key,
            code: key,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
            composed: true,
        });

        for (const prop of ['keyCode', 'which']) {
            if (event[prop] === keyCode) continue;
            try {
                Object.defineProperty(event, prop, { get: () => keyCode });
            } catch (_) {
                // 読み取り専用プロパティを補強できない環境では、そのまま送出する
            }
        }

        return event;
    }

    function simulateArrowKey(key) {
        const target = document.activeElement || document.body || document;
        target.dispatchEvent(createArrowKeyEvent('keydown', key));
        target.dispatchEvent(createArrowKeyEvent('keyup', key));
    }

    function executeCursorAction(action) {
        const key = CURSOR_KEY_BY_ACTION[action];
        if (!key) return false;

        const editable = getFocusedEditable();
        const direction = CURSOR_DIRECTION_BY_ACTION[action];
        if (editable?.isContentEditable && moveContentEditableCursor(action)) return true;
        if (editable && moveTextControlCursor(editable, direction)) return true;

        simulateArrowKey(key);
        return true;
    }

    async function executeBrowserPageAction(action, data = {}) {
        if (!BROWSER_PAGE_ACTIONS.has(action)) return false;
        if (CURSOR_KEY_BY_ACTION[action]) {
            executeCursorAction(action);
            return { ok: true, overlay: true };
        }
        if (SCROLL_ACTIONS.has(action)) return await executeTargetedScrollAction(action, data);
        if (POINTER_TOP_ACTIONS.has(action) && !isTopFrame()) return { ok: true, overlay: false };

        switch (action) {
            case 'pointerShow':
                updateVirtualPointer(false);
                return { ok: true, overlay: false };
            case 'pointerHide':
                hideVirtualPointer();
                return { ok: true, overlay: false };
            case 'pointerMoveStart':
                startVirtualPointerMove();
                return { ok: true, overlay: false };
            case 'pointerMoveEnd':
                endVirtualPointerMove();
                return { ok: true, overlay: false };
            case 'pointerMove':
                moveVirtualPointer(Number(data.left) || 0, Number(data.top) || 0);
                return { ok: true, overlay: false };
            case 'pointerClick':
                return await clickVirtualPointerTarget();
            case 'pointerClickAt':
                return await clickTargetAt(Number(data.x) || 0, Number(data.y) || 0);
            case 'pointerTargetAt':
                return await describePointerTargetAt(Number(data.x) || 0, Number(data.y) || 0);
        }
        return { ok: true, overlay: true };
    }

    /**
     * アクションを実行する。
     */
    async function executeAction(action, data) {
        const browserResult = await executeBrowserPageAction(action, data);
        if (browserResult !== false) {
            if (browserResult?.overlay) showOverlay(action);
            return browserResult || { ok: true };
        }

        const media = findBestMediaElement();

        switch (action) {
            case 'playPause':
                if (!media) break;
                if (media.paused) {
                    media.play().catch(() => {});
                } else {
                    media.pause();
                }
                break;

            case 'play':
                if (media) media.play().catch(() => {});
                break;

            case 'pause':
                if (media) media.pause();
                break;

            case 'volumeUp':
                if (media) {
                    media.volume = Math.min(1, media.volume + 0.1);
                    media.muted = false;
                }
                break;

            case 'volumeDown':
                if (media) {
                    media.volume = Math.max(0, media.volume - 0.1);
                }
                break;

            case 'mute':
                if (media) media.muted = !media.muted;
                break;

            case 'seekForward':
                if (media) media.currentTime = Math.min(media.duration || Infinity, media.currentTime + 10);
                break;

            case 'seekBackward':
                if (media) media.currentTime = Math.max(0, media.currentTime - 10);
                break;

            case 'speedUp':
                if (media) media.playbackRate = Math.min(4, Math.round((media.playbackRate + 0.25) * 100) / 100);
                break;

            case 'speedDown':
                if (media) media.playbackRate = Math.max(0.25, Math.round((media.playbackRate - 0.25) * 100) / 100);
                break;

            case 'resetSpeed':
                if (media) media.playbackRate = 1;
                break;

            case 'nextTrack':
                if (isYouTube() && youtubeNavigate('next')) break;
                // 汎用: MediaSession の nexttrack に頼る or キーイベント
                simulateMediaKey('MediaTrackNext');
                break;

            case 'previousTrack':
            case 'prevTrack':
                if (isYouTube() && youtubeNavigate('prev')) break;
                simulateMediaKey('MediaTrackPrevious');
                break;

        }

        // 実行結果をバッジ等で視覚フィードバック（オーバーレイ表示）
        showOverlay(action);
        return { ok: true };
    }

    /**
     * メディアキーのキーボードイベントをシミュレートする。
     */
    function simulateMediaKey(key) {
        const opts = { key, code: key, bubbles: true, cancelable: true };
        document.dispatchEvent(new KeyboardEvent('keydown', opts));
        document.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    /**
     * 操作フィードバック用のオーバーレイを一瞬表示する。
     */
    const ACTION_ICONS = {
        playPause:     '▶⏸',
        play:          '▶',
        pause:         '⏸',
        volumeUp:      '🔊',
        volumeDown:    '🔉',
        mute:          '🔇',
        seekForward:   '⏩',
        seekBackward:  '⏪',
        nextTrack:     '⏭',
        prevTrack:     '⏮',
        previousTrack: '⏮',
        speedUp:       '⏫',
        speedDown:     '⏬',
        resetSpeed:    '1×',
        directionalScroll: '↕',
        scrollDown:    '↓',
        scrollUp:      '↑',
        scrollRight:   '→',
        scrollLeft:    '←',
        pageTop:       '↟',
        pageBottom:    '↡',
        cursorUp:      '⇡',
        cursorDown:    '⇣',
        cursorLeft:    '⇠',
        cursorRight:   '⇢',
        historyBack:   '↩',
        historyForward: '↪',
        nextTab:       '⇥',
        previousTab:   '⇤',
        reload:        '↻',
        zoomIn:        '＋',
        zoomOut:       '−',
        resetZoom:     '100%',
        pointerMove:   '🟡',
        pointerClick:  '👆',
    };

    let overlayTimer = null;

    function showOverlay(action) {
        const icon = ACTION_ICONS[action];
        if (!icon) return;

        let el = document.getElementById('__nyand_overlay');
        if (!el) {
            el = document.createElement('div');
            el.id = '__nyand_overlay';
            Object.assign(el.style, {
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%) scale(1)',
                fontSize: '72px',
                lineHeight: '1',
                padding: '24px',
                borderRadius: '20px',
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                zIndex: '2147483647',
                pointerEvents: 'none',
                transition: 'opacity 0.3s ease, transform 0.3s ease',
                opacity: '0',
                fontFamily: 'system-ui, sans-serif',
                textAlign: 'center',
            });
            document.body.appendChild(el);
        }

        el.textContent = icon;
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%, -50%) scale(1)';

        if (overlayTimer) clearTimeout(overlayTimer);
        overlayTimer = setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translate(-50%, -50%) scale(0.5)';
        }, 600);
    }

    window.addEventListener('message', handleFrameMessage);
    window.addEventListener('focus', reportThisFrameFocused, true);
    document.addEventListener('focusin', reportThisFrameFocused, true);
    document.addEventListener('mousedown', reportThisFrameFocused, true);
    document.addEventListener('load', (event) => {
        if (isFrameElement(event.target)) scheduleAssignChildFramePaths();
    }, true);

    const frameObserverRoot = document.documentElement || document;
    if (frameObserverRoot) {
        new MutationObserver(scheduleAssignChildFramePaths)
            .observe(frameObserverRoot, { childList: true, subtree: true });
    }

    if (isTopFrame()) {
        setFramePath([]);
    } else {
        startFramePathRequests();
    }

    // Service Worker からのメッセージを受信
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'mediaAction') {
            executeAction(message.action, message.data)
                .then(result => sendResponse(result || { ok: true }))
                .catch((err) => {
                    sendResponse({
                        ok: false,
                        reason: 'frameActionUnavailable',
                        message: err?.message || String(err),
                    });
                });
            return true;
        }
        return true;
    });

    window.addEventListener('resize', () => {
        if (!virtualPointer.cursorEl) return;
        initPointerPosition();
        updateVirtualPointer(false);
    });

    window.addEventListener('scroll', () => {
        if (!virtualPointer.cursorEl) return;
        updatePointerTarget(false);
    }, true);
})();
