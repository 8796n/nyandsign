/**
 * NyandSign — Content Script
 *
 * Service Worker から受信したアクションを
 * ページ内の動画/音声要素やスクロールに適用する。
 */

(() => {
    'use strict';
    if (globalThis.__nyandsignContentScriptLoaded) {
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
        'pointerShow', 'pointerHide', 'pointerMoveStart', 'pointerMoveEnd', 'pointerMove', 'pointerClick',
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

    const SCROLL_ACTIONS = new Set([
        'directionalScroll', 'scrollDown', 'scrollUp', 'scrollRight', 'scrollLeft', 'pageTop', 'pageBottom',
    ]);
    const NYAND_OVERLAY_IDS = new Set([
        '__nyand_virtual_pointer',
        '__nyand_virtual_pointer_cross',
        '__nyand_virtual_pointer_blocked',
        '__nyand_pointer_target',
        '__nyand_overlay',
    ]);

    let lastFocusedFrameElement = null;

    function getFocusedEditable() {
        const el = document.activeElement;
        if (!el) return null;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) return el;
        return null;
    }

    function getScrollRoot(doc = document) {
        return doc.scrollingElement || doc.documentElement || doc.body;
    }

    function isDocumentRootElement(el, doc = document) {
        return el === doc.documentElement || el === doc.body;
    }

    function isNyandOverlayElement(el) {
        return !!el?.id && NYAND_OVERLAY_IDS.has(el.id);
    }

    function rectContainsPoint(rect, x, y) {
        return rect && rect.width > 0 && rect.height > 0 &&
            x >= rect.left && x <= rect.right &&
            y >= rect.top && y <= rect.bottom;
    }

    function meaningfulElementFromPointInDocument(doc, x, y, options = {}) {
        const allowRoot = options.allowRoot === true;
        const stack = typeof doc.elementsFromPoint === 'function'
            ? doc.elementsFromPoint(x, y)
            : [doc.elementFromPoint(x, y)].filter(Boolean);

        const firstUsable = stack.find(el => el && !isNyandOverlayElement(el) && !isDocumentRootElement(el, doc));
        if (firstUsable) return firstUsable;

        const active = doc.activeElement;
        if (active && !isDocumentRootElement(active, doc) && !isNyandOverlayElement(active)) {
            const rect = active.getBoundingClientRect();
            if (rectContainsPoint(rect, x, y)) return active;
        }

        return allowRoot
            ? stack.find(el => el && !isNyandOverlayElement(el)) || null
            : null;
    }

    function meaningfulElementFromPoint(x, y, options = {}) {
        return meaningfulElementFromPointInDocument(document, x, y, options);
    }

    function isFrameElement(el) {
        const tag = el?.tagName?.toLowerCase();
        if (tag === 'iframe' || tag === 'frame') return true;
        return el instanceof HTMLIFrameElement ||
            (typeof HTMLFrameElement === 'function' && el instanceof HTMLFrameElement);
    }

    function visibleFrameElement(el, doc = document) {
        if (!isFrameElement(el)) return false;
        const rect = el.getBoundingClientRect();
        const view = doc.defaultView || window;
        return rect.width > 0 && rect.height > 0 &&
            rect.bottom >= 0 && rect.top <= view.innerHeight &&
            rect.right >= 0 && rect.left <= view.innerWidth;
    }

    function rememberFocusedFrameElement(frameEl) {
        if (frameEl?.ownerDocument === document && visibleFrameElement(frameEl)) {
            lastFocusedFrameElement = frameEl;
        }
    }

    function activeDirectFrameElement() {
        const el = document.activeElement;
        return visibleFrameElement(el) ? el : null;
    }

    function focusedScrollableFrameElement() {
        const active = activeDirectFrameElement();
        if (active) {
            rememberFocusedFrameElement(active);
            return active;
        }

        if (lastFocusedFrameElement?.isConnected && visibleFrameElement(lastFocusedFrameElement)) {
            return lastFocusedFrameElement;
        }
        lastFocusedFrameElement = null;
        return null;
    }

    function reportFocusedFrameElement() {
        const active = activeDirectFrameElement();
        if (active) rememberFocusedFrameElement(active);
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

    function accessibleFrameDocument(frameEl) {
        try {
            const doc = frameEl?.contentWindow?.document;
            return doc?.documentElement ? doc : null;
        } catch (_) {
            return null;
        }
    }

    function localPointInFrame(frameEl, x, y) {
        const rect = frameEl.getBoundingClientRect();
        return {
            rect,
            x: clamp(x - rect.left, 0, Math.max(0, rect.width - 1)),
            y: clamp(y - rect.top, 0, Math.max(0, rect.height - 1)),
        };
    }

    function describePointerTargetInDocument(doc, x, y) {
        const target = meaningfulElementFromPointInDocument(doc, x, y);
        if (!target) {
            return { ok: true, targetRect: null };
        }

        if (visibleFrameElement(target, doc)) {
            const directResult = describeDirectFrameTarget(target, x, y);
            if (directResult?.targetRect) return directResult;

            return {
                ok: true,
                targetRect: plainRect(target.getBoundingClientRect()),
                handledBy: 'directFrame',
            };
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return { ok: true, targetRect: null };
        }
        return {
            ok: true,
            targetRect: plainRect(rect),
            handledBy: 'directFrame',
        };
    }

    function describeDirectFrameTarget(frameEl, x, y) {
        const point = localPointInFrame(frameEl, x, y);
        const doc = accessibleFrameDocument(frameEl);
        if (!doc) {
            return {
                ok: true,
                targetRect: plainRect(point.rect),
                inaccessibleFrame: true,
                handledBy: 'inaccessibleFrame',
            };
        }

        const result = describePointerTargetInDocument(doc, point.x, point.y);
        if (result?.targetRect) {
            return {
                ...result,
                targetRect: translateRect(result.targetRect, point.rect.left, point.rect.top),
                handledBy: result.handledBy || 'directFrame',
            };
        }
        return result ? { ...result, handledBy: result.handledBy || 'directFrame' } : null;
    }

    function isScrollable(el, axis, allowVisible = false) {
        if (!el) return false;
        const scrollSize = axis === 'x' ? el.scrollWidth : el.scrollHeight;
        const clientSize = axis === 'x' ? el.clientWidth : el.clientHeight;
        if (scrollSize <= clientSize + 8) return false;

        const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
        const overflow = axis === 'x' ? style.overflowX : style.overflowY;
        return ['auto', 'scroll', 'overlay'].includes(overflow) || (allowVisible && overflow === 'visible');
    }

    function findScrollableElement(axis, doc = document) {
        const root = getScrollRoot(doc);
        if (isScrollable(root, axis, true)) return root;

        const view = doc.defaultView || window;
        const centerX = view.innerWidth / 2;
        const centerY = view.innerHeight / 2;
        const underPointer = typeof doc.elementsFromPoint === 'function'
            ? doc.elementsFromPoint(centerX, centerY)
            : [];
        for (const el of underPointer) {
            if (isScrollable(el, axis)) return el;
        }

        let best = null;
        let bestArea = 0;
        for (const el of doc.querySelectorAll('*')) {
            if (!isScrollable(el, axis)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.bottom < 0 || rect.top > view.innerHeight) continue;
            if (rect.right < 0 || rect.left > view.innerWidth) continue;
            const area = rect.width * rect.height;
            if (area > bestArea) {
                best = el;
                bestArea = area;
            }
        }
        return best || root;
    }

    function scrollPageBy(left, top, smooth = true, doc = document) {
        const behavior = smooth ? 'smooth' : 'auto';
        if (top) findScrollableElement('y', doc).scrollBy({ top, behavior });
        if (left) findScrollableElement('x', doc).scrollBy({ left, behavior });
    }

    function executeLocalScrollAction(action, data = {}, doc = document) {
        const view = doc.defaultView || window;
        switch (action) {
            case 'directionalScroll':
                scrollPageBy(Number(data.left) || 0, Number(data.top) || 0, false, doc);
                return true;
            case 'scrollDown':
                scrollPageBy(0, Math.round(view.innerHeight * 0.55), true, doc);
                return true;
            case 'scrollUp':
                scrollPageBy(0, -Math.round(view.innerHeight * 0.55), true, doc);
                return true;
            case 'scrollRight':
                scrollPageBy(Math.round(view.innerWidth * 0.55), 0, true, doc);
                return true;
            case 'scrollLeft':
                scrollPageBy(-Math.round(view.innerWidth * 0.55), 0, true, doc);
                return true;
            case 'pageTop':
                findScrollableElement('y', doc).scrollTo({ top: 0, behavior: 'smooth' });
                return true;
            case 'pageBottom':
                {
                    const scroller = findScrollableElement('y', doc);
                    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
                }
                return true;
            default:
                return false;
        }
    }

    function executeTargetedScrollAction(action, data = {}) {
        const frameEl = focusedScrollableFrameElement();
        const frameDoc = frameEl ? accessibleFrameDocument(frameEl) : null;
        if (frameDoc) {
            executeLocalScrollAction(action, data, frameDoc);
            return { ok: true, overlay: false };
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
        blockedEl: null,
        targetEl: null,
        dimTimer: null,
        staleTimer: null,
        moving: false,
        blocked: false,
        targetSource: '',
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
            const blocked = document.createElement('div');
            blocked.id = '__nyand_virtual_pointer_blocked';
            Object.assign(blocked.style, {
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: '15px',
                height: '15px',
                border: '2px solid rgba(255, 255, 255, 0.98)',
                borderRadius: '50%',
                transform: 'translate(-50%, -50%)',
                background: 'linear-gradient(135deg, transparent 43%, rgba(255, 255, 255, 0.98) 46%, rgba(255, 255, 255, 0.98) 54%, transparent 57%)',
                filter: 'drop-shadow(0 0 2px rgba(0, 0, 0, 0.75))',
                opacity: '0',
                transition: 'opacity 0.12s ease',
            });
            el.appendChild(blocked);
            root.appendChild(el);
            virtualPointer.cursorEl = el;
            virtualPointer.crossEl = cross;
            virtualPointer.blockedEl = blocked;
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
        return meaningfulElementFromPoint(virtualPointer.x, virtualPointer.y);
    }

    function hidePointerTarget() {
        if (virtualPointer.targetEl) {
            virtualPointer.targetEl.style.opacity = '0';
        }
        virtualPointer.blocked = false;
        virtualPointer.targetSource = '';
    }

    function applyPointerTargetRect(rect, active = false, source = '', options = {}) {
        if (!virtualPointer.targetEl || !rect) return;
        const width = Number(rect.width) || 0;
        const height = Number(rect.height) || 0;
        if (width <= 0 || height <= 0) {
            hidePointerTarget();
            return;
        }

        const blocked = options.blocked === true;
        virtualPointer.blocked = blocked;
        Object.assign(virtualPointer.targetEl.style, {
            left: `${Math.max(0, Number(rect.left) - 3)}px`,
            top: `${Math.max(0, Number(rect.top) - 3)}px`,
            width: `${Math.min(window.innerWidth, width + 6)}px`,
            height: `${Math.min(window.innerHeight, height + 6)}px`,
            borderColor: blocked ? 'rgba(244, 63, 94, 0.95)' : 'rgba(255, 193, 7, 0.85)',
            boxShadow: blocked
                ? '0 0 0 2px rgba(0, 0, 0, 0.26), 0 0 14px rgba(244, 63, 94, 0.45)'
                : '0 0 0 2px rgba(0, 0, 0, 0.22)',
            opacity: active ? (blocked ? '0.9' : '0.85') : (blocked ? '0.55' : '0.35'),
        });
        virtualPointer.targetSource = source;
    }

    function updatePointerTargetFromFrame(frameEl, x, y, active, fallbackRect) {
        const directResult = describeDirectFrameTarget(frameEl, x, y);
        if (directResult?.targetRect) {
            applyPointerTargetRect(
                directResult.targetRect,
                active,
                directResult.inaccessibleFrame ? 'frame-blocked' : 'frame-direct',
                { blocked: directResult.inaccessibleFrame === true },
            );
            return;
        }

        applyPointerTargetRect(fallbackRect, active, 'frame-fallback');
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
        if (visibleFrameElement(target)) {
            updatePointerTargetFromFrame(target, virtualPointer.x, virtualPointer.y, active, fallbackRect);
        } else {
            applyPointerTargetRect(fallbackRect, active, 'local');
        }
    }

    function applyVirtualPointerStyle(active, moving) {
        const el = virtualPointer.cursorEl;
        if (!el) return;

        const blocked = virtualPointer.blocked;
        el.style.opacity = active ? '0.96' : '0.38';
        el.style.transform = active
            ? 'translate(-50%, -50%) scale(1.12)'
            : 'translate(-50%, -50%) scale(1)';
        el.style.borderColor = blocked
            ? 'rgba(244, 63, 94, 1)'
            : (moving ? 'rgba(255, 224, 102, 1)' : 'rgba(255, 193, 7, 0.95)');
        el.style.background = blocked
            ? 'rgba(244, 63, 94, 0.32)'
            : (moving ? 'rgba(255, 193, 7, 0.38)' : 'rgba(255, 193, 7, 0.24)');
        el.style.boxShadow = blocked
            ? '0 0 0 5px rgba(0, 0, 0, 0.34), 0 0 24px rgba(244, 63, 94, 0.68)'
            : (moving
                ? '0 0 0 5px rgba(0, 0, 0, 0.34), 0 0 24px rgba(255, 193, 7, 0.72)'
                : '0 0 0 4px rgba(0, 0, 0, 0.28), 0 0 18px rgba(255, 193, 7, 0.55)');
        if (virtualPointer.crossEl) {
            virtualPointer.crossEl.style.opacity = moving && !blocked ? '0.96' : '0';
        }
        if (virtualPointer.blockedEl) {
            virtualPointer.blockedEl.style.opacity = blocked ? (active ? '0.96' : '0.72') : '0';
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
        updatePointerTarget(active);
        applyVirtualPointerStyle(active, moving);

        if (virtualPointer.dimTimer) clearTimeout(virtualPointer.dimTimer);
        virtualPointer.dimTimer = null;
        if (!moving) {
            virtualPointer.dimTimer = setTimeout(() => {
                if (!virtualPointer.cursorEl) return;
                updatePointerTarget(false);
                applyVirtualPointerStyle(false, false);
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
        virtualPointer.blockedEl = null;
        virtualPointer.targetEl = null;
        virtualPointer.moving = false;
        virtualPointer.blocked = false;
        virtualPointer.targetSource = '';
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

    function createMouseEventAtForView(view, type, x, y) {
        const EventCtor = view?.MouseEvent || MouseEvent;
        return new EventCtor(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: view || window,
            clientX: x,
            clientY: y,
            screenX: (view?.screenX ?? window.screenX) + x,
            screenY: (view?.screenY ?? window.screenY) + y,
            button: 0,
            buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
        });
    }

    function createMouseEventAt(type, x, y) {
        return createMouseEventAtForView(window, type, x, y);
    }

    async function clickTargetInDocument(doc, x, y) {
        const target = meaningfulElementFromPointInDocument(doc, x, y, { allowRoot: true });
        if (!target) return { ok: true, overlay: false, handledBy: 'directFrame' };

        if (visibleFrameElement(target, doc)) {
            const directResult = await clickDirectFrameTarget(target, x, y);
            if (directResult) return directResult;
        }

        if (doc === document) {
            lastFocusedFrameElement = null;
        }

        try {
            if (typeof target.focus === 'function') {
                target.focus({ preventScroll: true });
            }
        } catch (_) {}

        const view = doc.defaultView || window;
        target.dispatchEvent(createMouseEventAtForView(view, 'mousemove', x, y));
        target.dispatchEvent(createMouseEventAtForView(view, 'mousedown', x, y));
        target.dispatchEvent(createMouseEventAtForView(view, 'mouseup', x, y));
        target.dispatchEvent(createMouseEventAtForView(view, 'click', x, y));
        return { ok: true, overlay: false, handledBy: 'directFrame' };
    }

    async function clickDirectFrameTarget(frameEl, x, y) {
        const point = localPointInFrame(frameEl, x, y);
        try {
            if (typeof frameEl.focus === 'function') {
                frameEl.focus({ preventScroll: true });
            }
        } catch (_) {}
        rememberFocusedFrameElement(frameEl);

        const doc = accessibleFrameDocument(frameEl);
        if (!doc) {
            return {
                ok: true,
                overlay: false,
                blockedFrame: true,
                handledBy: 'inaccessibleFrame',
            };
        }

        return await clickTargetInDocument(doc, point.x, point.y);
    }

    async function clickTargetAt(x, y) {
        const target = meaningfulElementFromPoint(x, y, { allowRoot: true });
        if (!target) return { ok: true, overlay: false };

        if (visibleFrameElement(target)) {
            const directResult = await clickDirectFrameTarget(target, x, y);
            if (directResult) return directResult;
        }

        lastFocusedFrameElement = null;

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

    window.addEventListener('focus', reportFocusedFrameElement, true);
    document.addEventListener('focusin', reportFocusedFrameElement, true);
    document.addEventListener('mousedown', reportFocusedFrameElement, true);

    // Service Worker からのメッセージを受信
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'mediaAction') {
            executeAction(message.action, message.data)
                .then(result => sendResponse(result || { ok: true }))
                .catch((err) => {
                    sendResponse({
                        ok: false,
                        reason: 'unknown',
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
