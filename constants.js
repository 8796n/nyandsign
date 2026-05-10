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
    thumbsup: '👍', thumbsdown: '👎', open: '🖐️', 'open-palm': '🖐️',
    three: '3️⃣', rock: '🤘', four: '4️⃣', unknown: '❓',
};

/** アクション表示名 — i18n キーへのマッピング */
const ACTION_I18N_KEYS = {
    playPause: 'actionPlayPause', play: 'actionPlay', pause: 'actionPause',
    volumeUp: 'actionVolumeUp', volumeDown: 'actionVolumeDown', mute: 'actionMute',
    nextTrack: 'actionNextTrack', prevTrack: 'actionPrevTrack',
    seekForward: 'actionSeekForward', seekBackward: 'actionSeekBackward',
    speedUp: 'actionSpeedUp', speedDown: 'actionSpeedDown', resetSpeed: 'actionResetSpeed',
    directionalScroll: 'actionDirectionalScroll',
    scrollDown: 'actionScrollDown', scrollUp: 'actionScrollUp',
    scrollRight: 'actionScrollRight', scrollLeft: 'actionScrollLeft',
    pageTop: 'actionPageTop', pageBottom: 'actionPageBottom',
    historyBack: 'actionHistoryBack', historyForward: 'actionHistoryForward',
    nextTab: 'actionNextTab', previousTab: 'actionPreviousTab',
    reload: 'actionReload',
    zoomIn: 'actionZoomIn', zoomOut: 'actionZoomOut', resetZoom: 'actionResetZoom',
    none: 'actionNone',
};

function actionLabel(key) {
    return msg(ACTION_I18N_KEYS[key] ?? 'actionNone');
}

const MEDIA_ACTION_KEYS = [
    'playPause', 'play', 'pause',
    'volumeUp', 'volumeDown', 'mute',
    'nextTrack', 'prevTrack',
    'seekForward', 'seekBackward',
    'speedUp', 'speedDown', 'resetSpeed',
    'none',
];

const BROWSER_ACTION_KEYS = [
    'directionalScroll',
    'scrollDown', 'scrollUp', 'scrollRight', 'scrollLeft',
    'pageTop', 'pageBottom',
    'historyBack', 'historyForward',
    'nextTab', 'previousTab',
    'reload',
    'zoomIn', 'zoomOut', 'resetZoom',
    'none',
];

const REPEATABLE_ACTIONS = new Set([
    'volumeUp', 'volumeDown', 'seekForward', 'seekBackward', 'speedUp', 'speedDown',
    'scrollDown', 'scrollUp', 'scrollRight', 'scrollLeft', 'zoomIn', 'zoomOut',
]);

const DIRECTIONAL_ACTIONS = new Set(['directionalScroll']);

const DEFAULT_MAPPING = {
    fist: 'pause',
    peace: 'playPause',
    three: 'nextTrack',
    four: 'prevTrack',
    ok: 'mute',
    aloha: 'play',
    rock: 'resetSpeed',
    'point-right': 'seekForward',
    'point-left': 'seekBackward',
    thumbsup: 'speedUp',
    thumbsdown: 'speedDown',
};

const DEFAULT_MEDIA_MAPPING = DEFAULT_MAPPING;

const DEFAULT_BROWSER_MAPPING = {
    fist: 'none',
    peace: 'none',
    three: 'historyForward',
    four: 'historyBack',
    ok: 'directionalScroll',
    aloha: 'none',
    rock: 'resetZoom',
    'point-right': 'scrollDown',
    'point-left': 'scrollUp',
    thumbsup: 'nextTab',
    thumbsdown: 'previousTab',
};

const OPERATION_MODES = {
    MEDIA: 'media',
    BROWSER: 'browser',
};

const WAKE_STATE = {
    IDLE: 'idle',
    ACTIVE: 'active',
};

const ACTION_COOLDOWN = 800;

/** 設定のデフォルト値 — sidepanel.js / pip.js で共有 */
const DEFAULT_SETTINGS = {
    mirrorCamera: true,
    skeletonOnly: false,
    wakeGestureType: 'open',
    wakeActiveDuration: 5000,
    operationMode: OPERATION_MODES.MEDIA,
    toggleGestureType: 'frame',
    preferredHand: 'auto',
    gestureHoldTime: 300,
    actionRepeatInterval: 1000,
    inferenceFps: 15,
    notifyVolume: 0.3,
    uiScale: 100,
    pipFontScale: 100,
};

const META_GESTURE_TYPES = ['frame', 'both-peace', 'peace-fist'];

const META_ACTION_I18N_KEYS = {
    toggleEnabled: 'metaActionToggleEnabled',
    toggleMode: 'metaActionToggleMode',
    setModeMedia: 'metaActionSetModeMedia',
    setModeBrowser: 'metaActionSetModeBrowser',
    none: 'metaActionNone',
};

const DEFAULT_META_GESTURE_MAPPING = {
    frame: 'toggleEnabled',
    'both-peace': 'toggleMode',
    'peace-fist': 'none',
};

function metaActionLabel(key) {
    return msg(META_ACTION_I18N_KEYS[key] ?? 'metaActionNone');
}
