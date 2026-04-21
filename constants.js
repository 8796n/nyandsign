/* ============================================================
 * 共通定数・ユーティリティ — sidepanel.js / pip.js で共有
 * ============================================================ */

/** i18n ヘルパー — chrome.i18n.getMessage のショートカット */
function msg(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
}

/** data-i18n / data-i18n-title 属性を走査して翻訳を適用 */
function applyI18n() {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    for (const el of document.querySelectorAll('[data-i18n]')) {
        const text = msg(el.dataset.i18n);
        if (text) el.textContent = text;
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
        const text = msg(el.dataset.i18nTitle);
        if (text) el.title = text;
    }
}

const GESTURE_ICONS = {
    fist: '✊', ok: '👌', aloha: '🤙', 'point-left': '👈', 'point-right': '👉', peace: '✌️',
    thumbsup: '👍', thumbsdown: '👎', open: '🖐️',
    three: '3️⃣', rock: '🤘', four: '4️⃣', unknown: '❓',
};

/** アクション表示名 — i18n キーへのマッピング */
const ACTION_I18N_KEYS = {
    playPause: 'actionPlayPause', play: 'actionPlay', pause: 'actionPause',
    volumeUp: 'actionVolumeUp', volumeDown: 'actionVolumeDown', mute: 'actionMute',
    nextTrack: 'actionNextTrack', prevTrack: 'actionPrevTrack',
    seekForward: 'actionSeekForward', seekBackward: 'actionSeekBackward',
    speedUp: 'actionSpeedUp', speedDown: 'actionSpeedDown', resetSpeed: 'actionResetSpeed',
    none: 'actionNone',
};

function actionLabel(key) {
    return msg(ACTION_I18N_KEYS[key] ?? 'actionNone');
}

const REPEATABLE_ACTIONS = new Set(['volumeUp', 'volumeDown', 'seekForward', 'seekBackward', 'speedUp', 'speedDown']);

const DEFAULT_MAPPING = {
    fist: 'pause',
    peace: 'playPause',
    ok: 'mute',
    aloha: 'play',
    'point-right': 'seekForward',
    'point-left': 'seekBackward',
    thumbsup: 'volumeUp',
    thumbsdown: 'volumeDown',
    three: 'nextTrack',
    rock: 'prevTrack',
    four: 'none',
};
