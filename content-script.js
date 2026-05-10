/**
 * NyandSign — Content Script
 *
 * Service Worker から受信したアクションを
 * ページ内の動画/音声要素やスクロールに適用する。
 */

(() => {
    'use strict';

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

    function isEditableFocused() {
        return !!getFocusedEditable();
    }

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

    function findHorizontalScroller() {
        const root = getScrollRoot();
        if (root && root.scrollWidth > root.clientWidth) return root;

        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const underPointer = document.elementsFromPoint(centerX, centerY);
        for (const el of underPointer) {
            if (el.scrollWidth > el.clientWidth + 8) return el;
        }

        let best = null;
        let bestArea = 0;
        for (const el of document.querySelectorAll('*')) {
            if (el.scrollWidth <= el.clientWidth + 8) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
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
        if (top) getScrollRoot().scrollBy({ top, behavior });
        if (left) findHorizontalScroller().scrollBy({ left, behavior });
    }

    function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
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

    function executeBrowserPageAction(action, data = {}) {
        if (!BROWSER_PAGE_ACTIONS.has(action)) return false;
        if (CURSOR_KEY_BY_ACTION[action]) return executeCursorAction(action);
        if (isEditableFocused()) return null;

        switch (action) {
            case 'directionalScroll':
                scrollPageBy(Number(data.left) || 0, Number(data.top) || 0, false);
                break;
            case 'scrollDown':
                scrollPageBy(0, Math.round(window.innerHeight * 0.55));
                break;
            case 'scrollUp':
                scrollPageBy(0, -Math.round(window.innerHeight * 0.55));
                break;
            case 'scrollRight':
                scrollPageBy(Math.round(window.innerWidth * 0.55), 0);
                break;
            case 'scrollLeft':
                scrollPageBy(-Math.round(window.innerWidth * 0.55), 0);
                break;
            case 'pageTop':
                getScrollRoot().scrollTo({ top: 0, behavior: 'smooth' });
                break;
            case 'pageBottom':
                getScrollRoot().scrollTo({ top: getScrollRoot().scrollHeight, behavior: 'smooth' });
                break;
        }
        return true;
    }

    /**
     * アクションを実行する。
     */
    function executeAction(action, data) {
        const browserResult = executeBrowserPageAction(action, data);
        if (browserResult !== false) {
            if (browserResult) showOverlay(action);
            return;
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

    // Service Worker からのメッセージを受信
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'mediaAction') {
            executeAction(message.action, message.data);
            sendResponse({ ok: true });
        }
        return true;
    });
})();
