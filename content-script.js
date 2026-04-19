/**
 * NyandSign — Content Script
 *
 * Service Worker から受信したメディアアクションを
 * ページ内の動画/音声要素に適用する。
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

    /**
     * メディアアクションを実行する。
     */
    function executeAction(action, data) {
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
        playPause:     '⏯',
        play:          '▶',
        pause:         '⏸',
        volumeUp:      '🔊',
        volumeDown:    '🔉',
        mute:          '🔇',
        seekForward:   '⏩',
        seekBackward:  '⏪',
        nextTrack:     '⏭',
        previousTrack: '⏮',

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
