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
    cursorUp: 'actionCursorUp', cursorDown: 'actionCursorDown',
    cursorLeft: 'actionCursorLeft', cursorRight: 'actionCursorRight',
    pageTop: 'actionPageTop', pageBottom: 'actionPageBottom',
    historyBack: 'actionHistoryBack', historyForward: 'actionHistoryForward',
    nextTab: 'actionNextTab', previousTab: 'actionPreviousTab',
    reload: 'actionReload',
    zoomIn: 'actionZoomIn', zoomOut: 'actionZoomOut', resetZoom: 'actionResetZoom',
    pointerMove: 'actionPointerMove', pointerClick: 'actionPointerClick',
    pointerShow: 'actionPointerShow', pointerHide: 'actionPointerHide',
    none: 'actionNone',
};

const ACTION_ICONS = {
    playPause: '▶⏸',
    play: '▶',
    pause: '⏸',
    volumeUp: '🔊',
    volumeDown: '🔉',
    mute: '🔇',
    nextTrack: '⏭',
    prevTrack: '⏮',
    seekForward: '⏩',
    seekBackward: '⏪',
    speedUp: '⏫',
    speedDown: '⏬',
    resetSpeed: '🔄',
    directionalScroll: '↕',
    scrollDown: '↓',
    scrollUp: '↑',
    scrollRight: '→',
    scrollLeft: '←',
    cursorUp: '⇡',
    cursorDown: '⇣',
    cursorLeft: '⇠',
    cursorRight: '⇢',
    pageTop: '↟',
    pageBottom: '↡',
    historyBack: '↩',
    historyForward: '↪',
    nextTab: '⇥',
    previousTab: '⇤',
    reload: '↻',
    zoomIn: '➕',
    zoomOut: '➖',
    resetZoom: '🔄',
    pointerMove: '🟡',
    pointerClick: '👆',
    pointerShow: '🟡',
    pointerHide: '—',
    none: '—',
};

function actionLabel(key) {
    return msg(ACTION_I18N_KEYS[key] ?? 'actionNone');
}

function actionDisplay(key) {
    const normalizedKey = ACTION_I18N_KEYS[key] ? key : 'none';
    const repeatSuffix = REPEATABLE_ACTIONS.has(normalizedKey) ? ' 🔁' : '';
    return `${ACTION_ICONS[normalizedKey]} ${actionLabel(normalizedKey)}${repeatSuffix}`;
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
    'cursorUp', 'cursorDown', 'cursorLeft', 'cursorRight',
    'pageTop', 'pageBottom',
    'historyBack', 'historyForward',
    'nextTab', 'previousTab',
    'reload',
    'zoomIn', 'zoomOut', 'resetZoom',
    'none',
];

const POINTER_ACTION_KEYS = [
    'pointerMove', 'pointerClick', 'none',
];

const REPEATABLE_ACTIONS = new Set([
    'volumeUp', 'volumeDown', 'seekForward', 'seekBackward', 'speedUp', 'speedDown',
    'scrollDown', 'scrollUp', 'scrollRight', 'scrollLeft', 'zoomIn', 'zoomOut',
    'cursorUp', 'cursorDown', 'cursorLeft', 'cursorRight',
]);

const DIRECTIONAL_ACTIONS = new Set(['directionalScroll']);
const POINTER_MOVE_ACTIONS = new Set(['pointerMove']);
const HOLD_GESTURE_RESUME_WINDOW_MS = 2000;

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
    fist: 'resetZoom',
    peace: 'none',
    three: 'pageTop',
    four: 'pageBottom',
    ok: 'directionalScroll',
    aloha: 'reload',
    rock: 'none',
    'point-right': 'nextTab',
    'point-left': 'previousTab',
    thumbsup: 'zoomIn',
    thumbsdown: 'zoomOut',
};

const DEFAULT_POINTER_MAPPING = {
    fist: 'pointerClick',
    peace: 'none',
    three: 'none',
    four: 'none',
    ok: 'pointerMove',
    aloha: 'none',
    rock: 'none',
    'point-right': 'none',
    'point-left': 'none',
    thumbsup: 'none',
    thumbsdown: 'none',
};

const LEGACY_DEFAULT_BROWSER_MAPPING = {
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

function isSameGestureMapping(mapping, baseline) {
    return Object.keys(baseline).every(key => mapping?.[key] === baseline[key]);
}

const OPERATION_MODES = {
    MEDIA: 'media',
    BROWSER: 'browser',
    POINTER: 'pointer',
};

const OPERATION_MODE_ORDER = [
    OPERATION_MODES.MEDIA,
    OPERATION_MODES.BROWSER,
    OPERATION_MODES.POINTER,
];

const WAKE_STATE = {
    IDLE: 'idle',
    ACTIVE: 'active',
};

const ACTION_COOLDOWN = 800;
const INFERENCE_FPS_MIN = 5;
const INFERENCE_FPS_MAX = 30;

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
    idleInferenceFps: 5,
    notifyVolume: 0.3,
    uiScale: 100,
    pipFontScale: 100,
    holdScrollSpeed: 100,
    pointerMoveSpeed: 100,
    experimentalPointerModeEnabled: false,
};

const MOVE_SPEED_MIN = 50;
const MOVE_SPEED_MAX = 200;
const MOVE_SPEED_DEFAULT = 100;

function normalizeMoveSpeed(value, fallback = MOVE_SPEED_DEFAULT) {
    const n = Number(value);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(MOVE_SPEED_MIN, Math.min(MOVE_SPEED_MAX, base));
}

function moveSpeedToMultiplier(value) {
    return normalizeMoveSpeed(value) / 100;
}

function normalizeInferenceFps(value, fallback = DEFAULT_SETTINGS.inferenceFps) {
    const n = Number(value);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(INFERENCE_FPS_MIN, Math.min(INFERENCE_FPS_MAX, base));
}

function resolveWakeInferenceFps(baseFps, wakeState, wakeGestureType, idleFps = DEFAULT_SETTINGS.idleInferenceFps) {
    const activeFps = normalizeInferenceFps(baseFps);
    if (wakeGestureType !== 'none' && wakeState === WAKE_STATE.IDLE) {
        return Math.min(activeFps, normalizeInferenceFps(idleFps));
    }
    return activeFps;
}

const META_GESTURE_TYPES = ['frame', 'both-peace', 'peace-fist'];

const META_ACTION_I18N_KEYS = {
    toggleEnabled: 'metaActionToggleEnabled',
    toggleMode: 'metaActionToggleMode',
    setModeMedia: 'metaActionSetModeMedia',
    setModeBrowser: 'metaActionSetModeBrowser',
    setModePointer: 'metaActionSetModePointer',
    none: 'metaActionNone',
};

const META_ACTION_ICONS = {
    toggleEnabled: '⏻',
    toggleMode: '⇄',
    setModeMedia: '🎬',
    setModeBrowser: '🌐',
    setModePointer: '🟡',
    none: '—',
};

const DEFAULT_META_GESTURE_MAPPING = {
    frame: 'toggleEnabled',
    'both-peace': 'toggleMode',
    'peace-fist': 'none',
};

function metaActionLabel(key) {
    return msg(META_ACTION_I18N_KEYS[key] ?? 'metaActionNone');
}

function metaActionDisplay(key) {
    const normalizedKey = META_ACTION_I18N_KEYS[key] ? key : 'none';
    return `${META_ACTION_ICONS[normalizedKey]} ${metaActionLabel(normalizedKey)}`;
}
