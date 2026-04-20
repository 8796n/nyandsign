/**
 * pip.js — PiP ポップアップウィンドウ用スクリプト
 *
 * 独立したトップレベルウィンドウでカメラ＋ハンドトラッキングを実行し、
 * 標準 Video PiP API で常に最前面のフロートウィンドウを表示する。
 * ジェスチャー検出結果は chrome.runtime.sendMessage 経由で
 * Service Worker → Content Script に送信される。
 *
 * サイドパネルとは独立して動作するため、サイドパネルを閉じても
 * ジェスチャー認識＋PiP 表示は継続する。
 */

/* ============================================================
 * 定数・マッピング
 * ============================================================ */

const DEFAULT_MAPPING = {
    fist: 'pause',
    peace: 'playPause',
    ok: 'mute',
    aloha: 'play',
    'point-right': 'seekForward',
    'point-left': 'seekBackward',
    thumbsup: 'volumeUp',
    thumbsdown: 'volumeDown',
};

const REPEATABLE_ACTIONS = new Set(['volumeUp', 'volumeDown', 'seekForward', 'seekBackward']);

const GESTURE_ICONS = {
    fist: '✊', ok: '👌', aloha: '🤙', 'point-left': '👈', 'point-right': '👉', peace: '✌️',
    thumbsup: '👍', thumbsdown: '👎', open: '🖐️', unknown: '❓',
};

/** アクション表示名 — i18n キーへのマッピング */
const ACTION_I18N_KEYS = {
    playPause: 'actionPlayPause', play: 'actionPlay', pause: 'actionPause',
    volumeUp: 'actionVolumeUp', volumeDown: 'actionVolumeDown', mute: 'actionMute',
    nextTrack: 'actionNextTrack', prevTrack: 'actionPrevTrack',
    seekForward: 'actionSeekForward', seekBackward: 'actionSeekBackward',
    none: 'actionNone',
};
function actionLabel(key) {
    const i18nKey = ACTION_I18N_KEYS[key];
    if (i18nKey) {
        const translated = chrome.i18n.getMessage(i18nKey);
        if (translated) return translated;
    }
    return key || '';
}
function msg(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
}
function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const text = msg(el.dataset.i18n);
        if (text) el.textContent = text;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const text = msg(el.dataset.i18nTitle);
        if (text) el.title = text;
    });
}

/* ============================================================
 * DOM 参照
 * ============================================================ */
const $ = (id) => document.getElementById(id);
const cameraVideo = $('camera-video');
const handCanvas  = $('hand-canvas');
const previewCanvas = $('preview-canvas');
const previewCtx    = previewCanvas.getContext('2d');
const pipVideoEl    = $('pip-video');
const btnStartPip   = $('btn-start-pip');
const statusEl      = $('status');

/* ============================================================
 * 状態
 * ============================================================ */
const tracker = new HandTracker();
let currentMapping = { ...DEFAULT_MAPPING };
let controlEnabled = true;
let notifyVolume = 0.3;            // 通知音量 (0.0〜1.0)
let pipFontScale = 1.0;            // PiP 文字サイズ倍率

// ウェイクサイン
const WAKE_STATE = { IDLE: 'idle', ACTIVE: 'active' };
let wakeState = WAKE_STATE.IDLE;
let wakeTimeout = null;
let wakeActiveDuration = 5000;
let wakeGestureType = 'open';

// ジェスチャー確定
let gestureHoldTime = 300;
let pendingActionTimer = null;
let pendingGesture = null;
let lastActionTime = 0;
const ACTION_COOLDOWN = 800;

// リピート
let actionRepeatInterval = 1000;
let repeatTimer = null;
let repeatingGesture = null;

// メタサイン
let toggleGestureType = 'frame';
let metaGestureActive = false;
let metaGestureStartTime = 0;
let metaGestureLastSeen = 0;
let lastToggleTime = 0;
const META_COOLDOWN_MS = 2000;
const META_GRACE_MS = 150;

// PiP 合成
let pipCanvas = null;
let pipCanvasCtx = null;
let pipTimerId = null;
let gestureText = '';
let wakeActive = false;

// カメラ
let cameraStream = null;
let mirrorCamera = true;
let pipActive = false;

// ターゲットタブ（ジェスチャーアクションの送信先 — アクティブタブに自動追従）
let targetTabId = (() => {
    const p = new URLSearchParams(location.search);
    const v = p.get('targetTab');
    return v ? parseInt(v, 10) : null;
})();

// 元のブラウザウィンドウ ID（サイドパネルを再度開くために使用）
const browserWindowId = (() => {
    const p = new URLSearchParams(location.search);
    const v = p.get('windowId');
    return v ? parseInt(v, 10) : null;
})();

// 単一インスタンス制御用
const instanceId = `pip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ポップアップ→サービスワーカー間のライフサイクルポート
let lifecyclePort = null;

// ターゲットタブ状態
let targetTabAlive = true;
let targetTabTitle = '';           // PiP canvas 描画用

/* ============================================================
 * 設定の読み込み
 * ============================================================ */
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get([
            'gestureMapping', 'controlEnabled', 'wakeGestureType',
            'wakeActiveDuration', 'toggleGestureType', 'gestureHoldTime',
            'actionRepeatInterval', 'skeletonOnly', 'mirrorCamera',
            'inferenceFps', 'preferredHand', 'notifyVolume', 'pipFontScale',
        ]);
        if (result.gestureMapping) currentMapping = { ...DEFAULT_MAPPING, ...result.gestureMapping };
        if (result.controlEnabled !== undefined) controlEnabled = result.controlEnabled;
        if (result.wakeGestureType) wakeGestureType = result.wakeGestureType;
        if (result.wakeActiveDuration) wakeActiveDuration = result.wakeActiveDuration;
        if (result.toggleGestureType) toggleGestureType = result.toggleGestureType;
        if (result.gestureHoldTime !== undefined) gestureHoldTime = result.gestureHoldTime;
        if (result.actionRepeatInterval) actionRepeatInterval = result.actionRepeatInterval;
        if (result.skeletonOnly) tracker.skeletonOnly = result.skeletonOnly;
        if (result.mirrorCamera !== undefined) mirrorCamera = result.mirrorCamera;
        if (result.inferenceFps) tracker.targetFps = result.inferenceFps;
        if (result.preferredHand) tracker.preferredHand = result.preferredHand;
        if (result.notifyVolume !== undefined) notifyVolume = Math.max(0, Math.min(1, Number(result.notifyVolume)));
        if (result.pipFontScale !== undefined) pipFontScale = Math.max(0.5, Math.min(2, Number(result.pipFontScale) / 100));
    } catch (_) {}
}

// 設定変更のリアルタイム反映
chrome.storage.onChanged.addListener((changes) => {
    if (changes.gestureMapping) currentMapping = { ...DEFAULT_MAPPING, ...changes.gestureMapping.newValue };
    if (changes.controlEnabled) controlEnabled = changes.controlEnabled.newValue;
    if (changes.wakeGestureType) wakeGestureType = changes.wakeGestureType.newValue;
    if (changes.wakeActiveDuration) wakeActiveDuration = changes.wakeActiveDuration.newValue;
    if (changes.toggleGestureType) toggleGestureType = changes.toggleGestureType.newValue;
    if (changes.gestureHoldTime) gestureHoldTime = changes.gestureHoldTime.newValue;
    if (changes.actionRepeatInterval) actionRepeatInterval = changes.actionRepeatInterval.newValue;
    if (changes.notifyVolume) notifyVolume = Math.max(0, Math.min(1, Number(changes.notifyVolume.newValue)));
    if (changes.pipFontScale) pipFontScale = Math.max(0.5, Math.min(2, Number(changes.pipFontScale.newValue) / 100));
    if (changes.skeletonOnly) tracker.skeletonOnly = changes.skeletonOnly.newValue;
    if (changes.mirrorCamera) {
        mirrorCamera = changes.mirrorCamera.newValue;
        tracker.displayMirrored = mirrorCamera;
    }
    if (changes.inferenceFps) tracker.targetFps = changes.inferenceFps.newValue;
    if (changes.preferredHand) tracker.preferredHand = changes.preferredHand.newValue;
});

/* ============================================================
 * ターゲットタブ監視
 * ============================================================
 * 操作対象タブの情報を表示し、タブが閉じられたらアクション停止
 */
const targetFaviconEl = $('target-favicon');
const targetTitleEl = $('target-title');
const targetTabBar = $('target-tab-bar');

/** ターゲットタブの情報を表示更新 */
function updateTargetTabInfo(tab) {
    if (!tab) return;
    const title = tab.title || tab.url || msg('pipTabTitleUnknown');
    targetTitleEl.textContent = title;
    targetTabTitle = title;
    targetTabAlive = true;
    targetTabBar.classList.remove('target-lost');
    if (tab.favIconUrl) {
        targetFaviconEl.src = tab.favIconUrl;
        targetFaviconEl.style.display = '';
    } else {
        targetFaviconEl.style.display = 'none';
    }
}

/** ターゲットタブが閉じられた時の処理 */
function onTargetTabLost() {
    targetTabAlive = false;
    const lostMsg = msg('pipTabLost');
    targetTitleEl.textContent = lostMsg;
    targetTabTitle = lostMsg;
    targetFaviconEl.style.display = 'none';
    targetTabBar.classList.add('target-lost');
}

// ブラウザウィンドウ内のアクティブタブ切替を自動追跡
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    // ポップアップ自身のウィンドウは無視
    if (browserWindowId && activeInfo.windowId !== browserWindowId) return;
    targetTabId = activeInfo.tabId;
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        updateTargetTabInfo(tab);
    } catch (_) {
        onTargetTabLost();
    }
});

// タイトル・favicon 変更を追跡（現在のターゲットタブのみ）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== targetTabId || !targetTabAlive) return;
    if (changeInfo.title) {
        targetTitleEl.textContent = changeInfo.title;
        targetTabTitle = changeInfo.title;
    }
    if (changeInfo.favIconUrl) {
        targetFaviconEl.src = changeInfo.favIconUrl;
        targetFaviconEl.style.display = '';
    }
});

// ターゲットタブ閉鎖の検出
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === targetTabId) onTargetTabLost();
});

// 初期表示
if (targetTabId) {
    chrome.tabs.get(targetTabId).then(updateTargetTabInfo).catch(() => onTargetTabLost());
} else {
    const fallbackMsg = msg('pipTabFallback');
    targetTitleEl.textContent = fallbackMsg;
    targetTabTitle = fallbackMsg;
}

/* ============================================================
 * 単一インスタンス制御
 * ============================================================ */
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'instance-takeover' && message.instanceId !== instanceId) {
        // 別のインスタンスに所有権が移った → 自身を停止
        stopPipComposite();
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
        tracker.stop();
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
            cameraStream = null;
        }
        chrome.runtime.sendMessage({ type: 'pip-closed' }).catch(() => {});
        window.close();
    }
});

/* ============================================================
 * 効果音（Web Audio API でビープ音生成）
 * ============================================================ */
let audioCtx = null;
function playBeep(freq = 880, duration = 0.12) {
    if (notifyVolume <= 0) return;
    try {
        if (!audioCtx) audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(notifyVolume, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch (_) {}
}

/* ============================================================
 * ウェイクサイン状態マシン
 * ============================================================ */
function setWakeState(newState) {
    wakeState = newState;
    if (wakeTimeout) { clearTimeout(wakeTimeout); wakeTimeout = null; }
    cancelPendingAction();
    stopRepeat();

    if (newState === WAKE_STATE.ACTIVE) {
        wakeActive = true;
        playBeep(880, 0.15);
        wakeTimeout = setTimeout(() => {
            setWakeState(WAKE_STATE.IDLE);
        }, wakeActiveDuration);
    } else {
        wakeActive = wakeGestureType === 'none';
    }
}

function extendWakeTimeout() {
    if (wakeGestureType === 'none') return;
    if (wakeTimeout) { clearTimeout(wakeTimeout); wakeTimeout = null; }
    wakeTimeout = setTimeout(() => {
        setWakeState(WAKE_STATE.IDLE);
    }, wakeActiveDuration);
}

/* ============================================================
 * ジェスチャー → アクション
 * ============================================================ */
function cancelPendingAction() {
    if (pendingActionTimer) { clearTimeout(pendingActionTimer); pendingActionTimer = null; }
    pendingGesture = null;
}

function stopRepeat() {
    if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
    repeatingGesture = null;
}

function stopAllGestureActions() {
    cancelPendingAction();
    const wasRepeating = repeatingGesture !== null;
    stopRepeat();
    if (wasRepeating && wakeGestureType !== 'none') {
        setWakeState(WAKE_STATE.IDLE);
    }
}

async function sendAction(action) {
    // ターゲットタブが閉じられている場合はアクションを送信しない
    if (!targetTabAlive && targetTabId) return;
    try {
        await chrome.runtime.sendMessage({
            type: 'gesture-action',
            action,
            targetTabId: targetTabId || undefined,
        });
    } catch (_) {}
}

function confirmAction(gesture, action) {
    const now = Date.now();
    if (now - lastActionTime < ACTION_COOLDOWN) return;
    lastActionTime = now;

    sendAction(action);

    if (REPEATABLE_ACTIONS.has(action) && actionRepeatInterval > 0) {
        repeatingGesture = gesture;
        repeatTimer = setInterval(() => {
            sendAction(action);
            extendWakeTimeout();
        }, actionRepeatInterval);
        return;
    }

    if (wakeGestureType !== 'none') {
        setWakeState(WAKE_STATE.IDLE);
    }
}

// ジェスチャーイベント
tracker.addEventListener('gesture', (e) => {
    const gesture = e.detail.gesture;
    if (!gesture) {
        gestureText = '';
        stopAllGestureActions();
        metaGestureActive = false;
        metaGestureStartTime = 0;
        return;
    }

    const icon = GESTURE_ICONS[gesture] || '❓';
    const mappedAction = currentMapping[gesture];
    // デフォルトは絵文字のみ（発火時のみコマンド名を付加）
    gestureText = icon;

    if (metaGestureActive) return;
    if (!controlEnabled) return;

    // open ウェイクモード
    if (wakeGestureType === 'open' && gesture === 'open') {
        stopAllGestureActions();
        if (wakeState === WAKE_STATE.IDLE) {
            setWakeState(WAKE_STATE.ACTIVE);
        }
        // ウェイクサイン発動時はコマンド名を表示
        gestureText = `${icon} ${actionLabel(mappedAction)}`;
        return;
    }

    if (wakeGestureType !== 'none' && wakeState !== WAKE_STATE.ACTIVE) return;

    const action = currentMapping[gesture];
    if (!action || action === 'none') { stopAllGestureActions(); return; }

    // メディアコマンドとして発火するのでコマンド名を表示
    gestureText = `${icon} ${actionLabel(action)}`;

    if (gesture === repeatingGesture || gesture === pendingGesture) return;

    cancelPendingAction();
    stopRepeat();
    pendingGesture = gesture;

    if (gestureHoldTime <= 0) {
        cancelPendingAction();
        confirmAction(gesture, action);
    } else {
        pendingActionTimer = setTimeout(() => {
            pendingActionTimer = null;
            pendingGesture = null;
            confirmAction(gesture, action);
        }, gestureHoldTime);
    }
});

/* ============================================================
 * メタサイン（操作トグル）
 * ============================================================ */
function dist2d(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function detectFrameGesture(hands) {
    for (let i = 0; i < hands.length; i++) {
        for (let j = i + 1; j < hands.length; j++) {
            const lm1 = hands[i].landmarks;
            const lm2 = hands[j].landmarks;
            const ps1 = dist2d(lm1[0], lm1[9]);
            const ps2 = dist2d(lm2[0], lm2[9]);
            const avgPs = (ps1 + ps2) / 2;
            const threshold = avgPs * 0.5;
            const d1 = dist2d(lm1[4], lm2[8]);
            const d2 = dist2d(lm1[8], lm2[4]);
            if (d1 < threshold && d2 < threshold) {
                const cy1 = (lm1[4].y + lm2[8].y) / 2;
                const cy2 = (lm1[8].y + lm2[4].y) / 2;
                if (Math.abs(cy1 - cy2) > avgPs * 0.3) return true;
            }
        }
    }
    return false;
}

function detectMetaGesture(hands) {
    if (toggleGestureType === 'none' || hands.length < 2) return false;
    switch (toggleGestureType) {
        case 'frame':      return detectFrameGesture(hands);
        case 'both-peace':  return hands.filter(h => h.gesture === 'peace').length >= 2;
        case 'peace-fist':  return hands.some(h => h.gesture === 'peace') &&
                                   hands.some(h => h.gesture === 'fist');
        default: return false;
    }
}

tracker.addEventListener('frame', (e) => {
    const { gestures: hands } = e.detail;
    const now = Date.now();

    if (now - lastToggleTime < META_COOLDOWN_MS) {
        metaGestureActive = false;
        return;
    }

    const detected = detectMetaGesture(hands);

    if (detected) {
        if (!metaGestureActive) {
            metaGestureActive = true;
            metaGestureStartTime = now;
            metaGestureLastSeen = now;
            cancelPendingAction();
            stopRepeat();
        }
        metaGestureLastSeen = now;

        const holdMs = Math.max(gestureHoldTime, 200);
        if (now - metaGestureStartTime >= holdMs) {
            controlEnabled = !controlEnabled;
            chrome.storage.sync.set({ controlEnabled });
            playBeep(controlEnabled ? 880 : 440, 0.2);
            lastToggleTime = now;
            metaGestureActive = false;
            metaGestureStartTime = 0;
            if (!controlEnabled) stopAllGestureActions();
        }
    } else if (metaGestureActive) {
        if (now - metaGestureLastSeen > META_GRACE_MS) {
            metaGestureActive = false;
            metaGestureStartTime = 0;
        }
    }
});

/* ============================================================
 * 合成描画（プレビュー + PiP 用 canvas）
 * ============================================================ */

/** 指定 canvas にカメラ + スケルトン + ジェスチャーテキストを合成描画 */
function compositeFrame(ctx, canvas) {
    const video = cameraVideo;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
    }

    const mirrored = tracker.displayMirrored;
    if (mirrored) {
        ctx.save();
        ctx.translate(vw, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.drawImage(handCanvas, 0, 0, vw, vh);
    if (mirrored) ctx.restore();

    // ジェスチャーテキスト
    if (gestureText) {
        ctx.save();
        const fontSize = Math.max(20, Math.round(vh * 0.07 * pipFontScale));
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = wakeActive
            ? 'rgba(0, 255, 100, 0.95)'
            : 'rgba(255, 255, 255, 0.85)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.lineWidth = 3;
        const x = vw / 2;
        const y = vh - 8;
        ctx.strokeText(gestureText, x, y);
        ctx.fillText(gestureText, x, y);
        ctx.restore();
    }

    // 操作 OFF 時の表示
    if (!controlEnabled) {
        const offLabel = msg('pipOverlayOff');
        ctx.save();
        const fontSize = Math.max(16, Math.round(vh * 0.05 * pipFontScale));
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(255, 80, 80, 0.9)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.lineWidth = 2;
        ctx.strokeText(offLabel, vw / 2, 8);
        ctx.fillText(offLabel, vw / 2, 8);
        ctx.restore();
    }

    // 操作状態を示す縁取り（ON: 緑、OFF: 赤）
    const borderWidth = Math.max(3, Math.round(Math.min(vw, vh) * 0.006));
    ctx.save();
    ctx.strokeStyle = controlEnabled
        ? 'rgba(0, 220, 80, 0.8)'
        : 'rgba(255, 60, 60, 0.8)';
    ctx.lineWidth = borderWidth * 2;
    ctx.strokeRect(0, 0, vw, vh);
    ctx.restore();

    // ターゲットタブ情報（上部に半透明バーで描画）
    if (targetTabTitle) {
        ctx.save();
        const barH = Math.max(20, Math.round(vh * 0.055 * pipFontScale));
        const fontSize = Math.max(11, Math.round(barH * 0.6));
        ctx.fillStyle = targetTabAlive
            ? 'rgba(0, 0, 0, 0.5)'
            : 'rgba(180, 40, 40, 0.7)';
        ctx.fillRect(0, 0, vw, barH);
        ctx.font = `${fontSize}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const maxTextW = vw - 16;
        let label = `🎯 ${targetTabTitle}`;
        // テキストが長い場合は省略
        while (ctx.measureText(label).width > maxTextW && label.length > 10) {
            label = label.slice(0, -4) + '…';
        }
        ctx.fillText(label, 6, barH / 2);
        ctx.restore();
    }
}

/** プレビュー描画ループ（PiP 開始前に使用） */
function previewLoop() {
    if (!cameraStream || pipActive) return;
    compositeFrame(previewCtx, previewCanvas);
    requestAnimationFrame(previewLoop);
}

/** PiP 合成ティック（setInterval: バックグラウンドでも停止しない） */
function pipCompositeTick() {
    if (!pipCanvas) return;
    compositeFrame(pipCanvasCtx, pipCanvas);
}

function stopPipComposite() {
    if (pipTimerId) { clearInterval(pipTimerId); pipTimerId = null; }
}

/* ============================================================
 * カメラ起動
 * ============================================================ */
async function startCamera() {
    statusEl.textContent = msg('pipStatusPreparing');

    // URL パラメータからカメラ ID を取得
    const params = new URLSearchParams(location.search);
    const cameraId = params.get('camera');

    try {
        // MediaPipe モデルロード
        if (!tracker.loaded) {
            statusEl.textContent = msg('mediaPipeLoading');
            await tracker.loadModel((key) => { statusEl.textContent = msg(key); });
        }

        // カメラ取得
        statusEl.textContent = msg('pipStatusConnecting');
        const constraints = {
            video: cameraId
                ? { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
                : { width: { ideal: 1280 }, height: { ideal: 720 } },
        };
        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);

        const track = cameraStream.getVideoTracks()[0];

        // メガネカメラの場合ミラー OFF
        const isXreal = /XREAL|3318|Nreal|0486|0817|0909/.test(track.label);
        if (isXreal) mirrorCamera = false;

        // カメラ切断監視 — ポップアップ内に案内を表示
        track.addEventListener('ended', () => {
            console.log('[PiP] カメラ切断を検出');
            // カメラ・トラッキングを停止
            stopPipComposite();
            tracker.stop();
            if (cameraStream) {
                cameraStream.getTracks().forEach(t => t.stop());
                cameraStream = null;
            }
            // PiP が動作中なら終了
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
            }
            // カメラ切断メッセージを表示
            const container = $('preview-container');
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.justifyContent = 'center';
            const pipMsg = $('pip-active-msg');
            pipMsg.style.display = 'none';
            const previewCanvas = $('preview-canvas');
            previewCanvas.style.display = 'none';
            $('btn-start-pip').style.display = 'none';
            $('target-tab-bar').style.display = 'none';
            $('status').textContent = msg('pipStatusCameraDisconnected');
            $('status').style.position = 'static';
            $('status').style.transform = 'none';
            $('status').style.fontSize = '15px';
            $('status').style.marginBottom = '12px';
            // 戻るボタンを中央に大きく表示
            const btnBack = $('btn-back');
            btnBack.style.position = 'static';
            btnBack.style.fontSize = '15px';
            btnBack.style.padding = '10px 24px';
            btnBack.style.opacity = '1';
        });

        tracker.displayMirrored = mirrorCamera;

        cameraVideo.srcObject = cameraStream;
        await new Promise(r => { cameraVideo.onloadeddata = r; });
        await cameraVideo.play();

        // トラッキング開始
        await tracker.start(cameraVideo, handCanvas, {
            skeletonOnly: tracker.skeletonOnly,
        });

        statusEl.textContent = msg('pipStatusCameraReady');
        btnStartPip.disabled = false;

        // プレビュー描画開始
        previewLoop();

    } catch (e) {
        statusEl.textContent = msg('pipStatusError', [e?.message || String(e)]);
        console.error('[PiP] Camera error:', e);
    }
}

/* ============================================================
 * PiP 開始 / 終了
 * ============================================================ */
async function enterPiP() {
    btnStartPip.disabled = true;

    try {
        const vw = cameraVideo.videoWidth || 640;
        const vh = cameraVideo.videoHeight || 480;
        pipCanvas = document.createElement('canvas');
        pipCanvas.width = vw;
        pipCanvas.height = vh;
        pipCanvasCtx = pipCanvas.getContext('2d');

        // 初期フレーム描画
        compositeFrame(pipCanvasCtx, pipCanvas);

        // canvas → MediaStream → video
        const stream = pipCanvas.captureStream(0);
        pipVideoEl.srcObject = stream;

        // 合成ループ開始（フレーム描画 + requestFrame でストリームに通知）
        const videoTrack = stream.getVideoTracks()[0];
        stopPipComposite();
        pipTimerId = setInterval(() => {
            pipCompositeTick();
            if (videoTrack.readyState === 'live') {
                videoTrack.requestFrame();
            }
        }, 33);

        // 再生待機
        if (pipVideoEl.readyState < 2) {
            await Promise.race([
                new Promise(r => pipVideoEl.addEventListener('canplay', r, { once: true })),
                new Promise(r => setTimeout(r, 500)),
            ]);
        }
        if (pipVideoEl.paused) await pipVideoEl.play();

        // PiP 開始（トップレベルウィンドウなので確実に動作する）
        await pipVideoEl.requestPictureInPicture();
        pipActive = true;

        // PiP 終了時: プレビューに戻る（ウィンドウは閉じない）
        pipVideoEl.addEventListener('leavepictureinpicture', () => {
            exitPiP();
        }, { once: true });

        // UI 切替
        $('preview-container').style.display = 'none';
        $('pip-active-msg').style.display = 'block';

    } catch (e) {
        stopPipComposite();
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
        pipVideoEl.srcObject = null;
        pipCanvas = null;
        pipCanvasCtx = null;

        statusEl.textContent = msg('pipStatusPipError', [e?.message || String(e)]);
        console.error('[PiP] Error:', e);
        btnStartPip.disabled = false;
    }
}

function exitPiP() {
    stopPipComposite();

    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }

    pipVideoEl.srcObject = null;
    pipCanvas = null;
    pipCanvasCtx = null;
    pipActive = false;

    // プレビューに戻る（カメラは維持）
    if (cameraStream) {
        $('preview-container').style.display = '';
        $('pip-active-msg').style.display = 'none';
        btnStartPip.disabled = false;
        previewLoop();
    }
}

/* ============================================================
 * 初期化
 * ============================================================ */
/**
 * サイドパネルに復帰する共通処理
 * ポート経由のサイドパネル復帰を抑制する場合は skipPortReturn を設定
 */
let skipPortReturn = false;
/** コード側からの意図的なクローズか（beforeunload ダイアログ抑制用） */
let closingIntentionally = false;

async function returnToSidepanel(autoRestart) {
    closingIntentionally = true;
    // カメラ切断時は autoRestart=false — ポート切断でのサイドパネル復帰は行うが
    // カメラ再開フラグは立てない
    if (!autoRestart) skipPortReturn = false;

    // PiP が動作中なら先に終了
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }
    // カメラを停止
    stopPipComposite();
    tracker.stop();
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }

    // 戻るボタン経由: await で確実に処理（ポート切断での二重処理を防止）
    if (autoRestart) {
        skipPortReturn = true;
        const params = new URLSearchParams(location.search);
        const cameraId = params.get('camera') || '';
        await chrome.storage.session.set({
            pipReturnToSidepanel: { cameraId },
        });
        if (browserWindowId) {
            try {
                await chrome.sidePanel.open({ windowId: browserWindowId });
            } catch (_) {}
        }
    }

    window.close();
}

btnStartPip.addEventListener('click', enterPiP);

// サイドパネルに戻るボタン
$('btn-back').addEventListener('click', () => returnToSidepanel(true));

// ウィンドウが閉じられる前にクリーンアップ
window.addEventListener('beforeunload', (e) => {
    // X ボタンによる閉じを防止（「サイドパネルに戻る」ボタンを使用させる）
    // returnToSidepanel() 経由の場合は closingIntentionally=true でダイアログ不要
    if (!closingIntentionally) {
        e.preventDefault();
        return;
    }
    // 戻るボタン経由で既に処理済みの場合はポート切断での復帰をスキップ
    if (skipPortReturn && lifecyclePort) {
        try { lifecyclePort.postMessage({ skipReturn: true }); } catch (_) {}
    }
    stopPipComposite();
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }
    tracker.stop();
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    // 所有権を解放
    chrome.runtime.sendMessage({ type: 'release-active-instance', instanceId }).catch(() => {});
});

// 起動
(async () => {
    applyI18n();
    await loadSettings();
    // ウェイク初期状態
    wakeActive = wakeGestureType === 'none';

    // ライフサイクルポート接続（onDisconnect でサイドパネル復帰）
    const params = new URLSearchParams(location.search);
    lifecyclePort = chrome.runtime.connect({ name: 'pip-lifecycle' });
    lifecyclePort.postMessage({
        browserWindowId,
        cameraId: params.get('camera') || '',
    });

    // 認識インスタンスの所有権を要求
    await chrome.runtime.sendMessage({
        type: 'claim-active-instance',
        instanceId,
        instanceType: 'popup',
        windowId: browserWindowId,
        targetTabId,
    }).catch(() => {});
    await startCamera();
})();
