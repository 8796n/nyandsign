/**
 * Side Panel — カメラ + ハンドトラッキング + メディアコントロール
 *
 * ブラウザに接続された全カメラに対応。カメラドロップダウンで選択可能。
 * 電気メガネカメラが検出された場合は自動で優先選択される。
 * MediaPipe でハンドサインを認識し、content-script 経由でメディア操作やブラウザ操作を行う。
 *
 * WebHID による UVC 有効化は外部の EyeCon ページが担当。
 */

/* グローバルエラーハンドラ */
window.addEventListener('error', (e) => {
    try { log(`❌ ${e.message} (${e.filename}:${e.lineno})`); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
    try { log(`❌ ${e.reason}`); } catch (_) {}
});

/* ============================================================
 * 定数
 * ============================================================ */

/** スライダー値の i18n フォーマットヘルパー */
function fmtSeconds(ms) {
    return ms === 0 ? msg('formatImmediate') : msg('formatSeconds', [(ms / 1000).toFixed(1)]);
}
function fmtFps(fps) { return msg('formatFps', [String(fps)]); }
function fmtPercent(n) { return msg('formatPercent', [String(n)]); }
function fmtVolume(v) { return v <= 0 ? msg('formatVolumeOff') : fmtPercent(Math.round(v * 100)); }

/* ハンドサイン表示名 — i18n メッセージから取得 */
const GESTURE_I18N_KEYS = {
    fist: 'gestureFist', peace: 'gesturePeace', ok: 'gestureOk', aloha: 'gestureAloha',
    'point-right': 'gesturePointRight', 'point-left': 'gesturePointLeft', 'point-up': 'gesturePointUp',
    thumbsup: 'gestureThumbsup', thumbsdown: 'gestureThumbsdown',
    three: 'gestureThree', rock: 'gestureRock', four: 'gestureFour',
    open: 'gestureOpen', 'open-palm': 'gestureOpenPalm', unknown: 'gestureUnknown',
};
function gestureLabel(key) {
    return msg(GESTURE_I18N_KEYS[key] ?? 'gestureUnknown');
}

const GESTURABLE_TYPES = [
    'fist', 'peace', 'three', 'four', 'ok', 'aloha', 'rock',
    'point-right', 'point-left', 'point-up', 'thumbsup', 'thumbsdown',
];

const CAMERA_POLL_INTERVAL = 3000;
const SIGN_DEBUG_LOG_INTERVAL_MS = 500;
const DEBUG_SCREENSHOT_SCALE = 2;

/* ============================================================
 * 状態
 * ============================================================ */
const tracker = new HandTracker();
let mediaMapping = { ...DEFAULT_MEDIA_MAPPING };
let browserMapping = { ...DEFAULT_BROWSER_MAPPING };
let pointerMapping = { ...DEFAULT_POINTER_MAPPING };
let currentMapping = { ...DEFAULT_MEDIA_MAPPING };
let operationMode = DEFAULT_SETTINGS.operationMode;
let controlEnabled = true;
let cameraStream = null;
let lastActionTime = 0;
let pageActionStatusVisible = false;
let cameraPollId = null;
let selectedCameraId = null;    // UI で選択中のカメラ
let selectedXrealCameraProfile = null; // XREAL Eye の UVC0/UVC1 選択復元用
let xrealCameraProfiles = {};   // deviceId ごとの実測プロファイルキャッシュ
let activeCameraId = null;      // 実際に動作中のカメラ
let availableCameras = [];      // 検出済みカメラリスト
let cameraCheckSeq = 0;         // checkCamera 排他制御用
let prevSelectedBeforeXreal = null;  // 電気メガネカメラ自動切替前の選択
let hadXrealCamera = false;          // 前回ポーリング時に電気メガネカメラがあったか

// --- ウェイクサイン状態マシン ---
// IDLE: サイン表示のみ、アクション発火しない
// ACTIVE: ウェイクサイン検出後、コマンドサインでアクション発火可能
let wakeState = WAKE_STATE.IDLE;
let wakeTimeout = null;
let wakeActiveDuration = DEFAULT_SETTINGS.wakeActiveDuration;
// ウェイクサイン種別: 'open' | 'open-palm' | 'none'
let wakeGestureType = DEFAULT_SETTINGS.wakeGestureType;
// サイン確定待機: 同じサインが holdTime 以上持続して初めてアクション発火
let gestureHoldTime = DEFAULT_SETTINGS.gestureHoldTime;
let pendingActionTimer = null;
let pendingGesture = null;
// リピート: 継続的なアクション（音量・シーク）のインターバル
let actionRepeatInterval = DEFAULT_SETTINGS.actionRepeatInterval;
let repeatTimer = null;
let repeatingGesture = null;
let continuousGestureGate = null;
let notifyVolume = DEFAULT_SETTINGS.notifyVolume;
let uiScale = DEFAULT_SETTINGS.uiScale;
let holdScrollSpeed = DEFAULT_SETTINGS.holdScrollSpeed;
let pointerMoveSpeed = DEFAULT_SETTINGS.pointerMoveSpeed;
let inferenceFps = DEFAULT_SETTINGS.inferenceFps;
let idleInferenceFpsEnabled = DEFAULT_SETTINGS.idleInferenceFpsEnabled;
let inferenceResolution = DEFAULT_SETTINGS.inferenceResolution;
let okDebugEnabled = DEFAULT_SETTINGS.okDebugEnabled;
let lastOkDebugLogAt = 0;
let lastOkDebugSignature = '';

// --- メタサイン（NyandSign 自体の操作）---
let toggleGestureType = DEFAULT_SETTINGS.toggleGestureType;
let metaGestureMapping = { ...DEFAULT_META_GESTURE_MAPPING };
let metaGestureController = null;
// メガネカメラ使用時のミラー自動OFF用
let savedMirrorState = null;       // null=自動変更なし, boolean=変更前の値

// --- 方向スクロール ---
let lastFrameHands = [];
let directionalScrollController = null;
let pointerMoveController = null;
let holdGestureResumeController = null;
let pointerVisibilityController = null;

// --- PiP (Picture-in-Picture) ---
let pipWindowId = null;             // PiP ポップアップウィンドウの ID
let pipTargetTabId = null;          // PiP 開始時のアクティブタブ ID

// --- ターゲットタブ固定 ---
let lockedTargetTabId = null;       // null = アクティブタブ追従, 数値 = 固定タブID
let settingsActiveTab = 'operation';

// --- 単一インスタンス制御 ---
const instanceId = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let takenOver = false;              // 別のインスタンスに所有権を奪われた
const cameraRestartController = CameraRuntime.createRestartController({
    isActive: () => !!cameraStream,
    restart: () => restartCameraForSettings(),
});

/* ============================================================
 * DOM
 * ============================================================ */
const $ = (id) => document.getElementById(id);
/** CSS で display:none が設定された要素の表示切替ヘルパー */
const show = (elem) => { elem.style.display = ''; elem.classList.remove('is-hidden'); };
const hide = (elem) => { elem.classList.add('is-hidden'); };
/** EyeCon 誘導用の特殊カメラ選択値 */
const EYECON_VALUE = '__eyecon__';
const SETTINGS_TAB_IDS = ['operation', 'display', 'recognition'];

const el = {
    setupHint:       $('setup-hint'),
    linkEyecon:      $('link-eyecon'),

    cameraControls:  $('camera-controls'),
    cameraSection:   $('camera-section'),
    cameraContainer: $('camera-container'),
    btnStartCam:     $('btn-start-camera'),
    btnStopCam:      $('btn-stop-camera'),
    chkMirror:       $('chk-mirror'),
    chkSkeleton:     $('chk-skeleton-only'),
    cameraVideo:     $('camera-video'),
    handCanvas:      $('hand-canvas'),

    gestureSection:  $('gesture-section'),
    gestureDisplay:  $('gesture-display'),
    gestureEmoji:    document.querySelector('#gesture-display .gesture-emoji'),
    gestureName:     document.querySelector('#gesture-display .gesture-name'),
    okDebugPanel:    $('ok-debug-panel'),
    okDebugActions:  $('ok-debug-actions'),
    btnCopyDebugScreenshot: $('btn-copy-debug-screenshot'),

    mappingList:     $('mapping-list'),
    metaMappingList: $('meta-mapping-list'),
    operationModeLabel: $('operation-mode-label'),
    chkEnabled:      $('chk-enabled'),
    chkIdleInferenceFps: $('chk-idle-inference-fps'),
    chkOkDebug:      $('chk-ok-debug'),

    log:             $('log'),
    btnClearLog:     $('btn-clear-log'),
};

/* ============================================================
 * ログ
 * ============================================================ */
function log(text) {
    const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
    el.log.textContent += `[${ts}] ${text}\n`;
    el.log.scrollTop = el.log.scrollHeight;
    console.log(`[GW] ${text}`);
}

/* ============================================================
 * サイン判定デバッグ
 * ============================================================ */
function formatOkDebugNumber(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '-';
}

function formatOkDebugBool(value) {
    return value ? '1' : '0';
}

function selectOkDebugHand(hands = [], activeIdx = null) {
    const active = hands.find(h => h.idx === activeIdx && h.okDebug);
    if (active) return active.okDebug;
    const okLike = hands.find(h =>
        h.okDebug && (h.gesture === 'ok' || h.okDebug.okPinch || h.okDebug.thumbIndexOkDist < 0.80));
    if (okLike) return okLike.okDebug;
    return hands.find(h => h.okDebug)?.okDebug || null;
}

function formatOkDebugDisplay(debug, stableGesture) {
    if (!debug) return 'SIGN_DEBUG\nhand=none';
    return [
        `SIGN_DEBUG hand=${debug.hand || '-'} raw=${debug.rawGesture || '-'} stable=${stableGesture || '-'}`,
        `dist=${formatOkDebugNumber(debug.thumbIndexOkDist)} tip=${formatOkDebugNumber(debug.thumbIndexTipDist)} pinch=${formatOkDebugBool(debug.okPinch)} relaxed=${formatOkDebugBool(debug.relaxedBentIndexOkPinch)} latch=${formatOkDebugBool(debug.okLatched)} strong=${formatOkDebugBool(debug.strongOkPinch)} strongIdx=${formatOkDebugBool(debug.strongIndexOkPinch)}`,
        `indexExt=${formatOkDebugBool(debug.indexExtended)} indexOk=${formatOkDebugBool(debug.indexExtendedOkPinch)} indexCurl=${formatOkDebugBool(debug.indexCurled)} indexBent=${formatOkDebugBool(debug.indexBentForOk)} indexStr=${formatOkDebugNumber(debug.indexStraightness)} otherExt=${debug.otherExtendedCount ?? '-'}`,
        `mid=${formatOkDebugBool(debug.middleExtended)} ring=${formatOkDebugBool(debug.ringExtended)} pinky=${formatOkDebugBool(debug.pinkyExtended)} thumbFold=${formatOkDebugBool(debug.thumbFolded)} thumbAway=${formatOkDebugBool(debug.thumbExtendedAway)} thumbPalm=${formatOkDebugNumber(debug.thumbPalmDist)} fourThumb=${formatOkDebugBool(debug.fourThumbTucked)} palm=${debug.palmFacing ? 'front' : 'back'}`,
        `fail=${debug.failureReason || '-'}`,
    ].join('\n');
}

function formatOkDebugLog(debug, stableGesture) {
    return `[SIGN_DEBUG] raw=${debug.rawGesture || '-'} stable=${stableGesture || '-'} ` +
        `dist=${formatOkDebugNumber(debug.thumbIndexOkDist)} tip=${formatOkDebugNumber(debug.thumbIndexTipDist)} ` +
        `pinch=${formatOkDebugBool(debug.okPinch)} relaxed=${formatOkDebugBool(debug.relaxedBentIndexOkPinch)} latch=${formatOkDebugBool(debug.okLatched)} strong=${formatOkDebugBool(debug.strongOkPinch)} strongIdx=${formatOkDebugBool(debug.strongIndexOkPinch)} ` +
        `indexExt=${formatOkDebugBool(debug.indexExtended)} indexOk=${formatOkDebugBool(debug.indexExtendedOkPinch)} indexBent=${formatOkDebugBool(debug.indexBentForOk)} indexStr=${formatOkDebugNumber(debug.indexStraightness)} otherExt=${debug.otherExtendedCount ?? '-'} ` +
        `thumbFold=${formatOkDebugBool(debug.thumbFolded)} thumbAway=${formatOkDebugBool(debug.thumbExtendedAway)} thumbPalm=${formatOkDebugNumber(debug.thumbPalmDist)} fourThumb=${formatOkDebugBool(debug.fourThumbTucked)} palm=${debug.palmFacing ? 'front' : 'back'} fail=${debug.failureReason || '-'}`;
}

function updateOkDebugPanelVisibility() {
    if (!el.okDebugPanel) return;
    if (okDebugEnabled) {
        show(el.okDebugPanel);
        if (el.okDebugActions) show(el.okDebugActions);
        if (!el.okDebugPanel.textContent) el.okDebugPanel.textContent = 'SIGN_DEBUG\nhand=none';
    } else {
        hide(el.okDebugPanel);
        if (el.okDebugActions) hide(el.okDebugActions);
        el.okDebugPanel.textContent = '';
    }
}

function setOkDebugEnabled(enabled, options = {}) {
    okDebugEnabled = enabled === true;
    if (el.chkOkDebug) el.chkOkDebug.checked = okDebugEnabled;
    if (!okDebugEnabled) {
        lastOkDebugLogAt = 0;
        lastOkDebugSignature = '';
    }
    updateOkDebugPanelVisibility();
    if (options.save !== false) {
        chrome.storage.sync.set({ okDebugEnabled }).catch(() => {});
    }
}

function updateOkDebug(detail, now = Date.now()) {
    if (!okDebugEnabled || !el.okDebugPanel) return;

    const debug = selectOkDebugHand(detail.gestures || [], detail.activeIdx);
    const stableGesture = detail.stableGesture || '-';
    el.okDebugPanel.textContent = formatOkDebugDisplay(debug, stableGesture);

    if (!debug) return;
    const isOkLike = debug.rawGesture === 'ok' || debug.okPinch || debug.thumbIndexOkDist < 0.80;
    if (!isOkLike) return;

    const distBucket = Number.isFinite(debug.thumbIndexOkDist)
        ? Math.round(debug.thumbIndexOkDist * 20) / 20
        : '-';
    const signature = [
        debug.failureReason,
        debug.rawGesture,
        stableGesture,
        distBucket,
        debug.indexExtended,
        debug.otherExtendedCount,
        debug.palmFacing,
    ].join('|');

    if (signature !== lastOkDebugSignature || now - lastOkDebugLogAt >= SIGN_DEBUG_LOG_INTERVAL_MS) {
        lastOkDebugSignature = signature;
        lastOkDebugLogAt = now;
        log(formatOkDebugLog(debug, stableGesture));
    }
}

/* ============================================================
 * デバッグスクリーンショット
 * ============================================================ */
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function roundedPath(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, width, height, radius);
        return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function fillRoundedRect(ctx, x, y, width, height, radius, fillStyle, strokeStyle = null) {
    roundedPath(ctx, x, y, width, height, radius);
    ctx.fillStyle = fillStyle;
    ctx.fill();
    if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.stroke();
    }
}

function wrapTextLine(ctx, line, maxWidth) {
    if (!line) return [''];
    if (ctx.measureText(line).width <= maxWidth) return [line];

    const chunks = line.split(/(\s+)/).filter(part => part.length > 0);
    const lines = [];
    let current = '';

    const pushLongChunk = (chunk) => {
        let piece = '';
        for (const ch of chunk) {
            const next = piece + ch;
            if (piece && ctx.measureText(next).width > maxWidth) {
                lines.push(piece);
                piece = ch;
            } else {
                piece = next;
            }
        }
        return piece;
    };

    for (const chunk of chunks) {
        const next = current + chunk;
        if (!current || ctx.measureText(next).width <= maxWidth) {
            current = next;
            continue;
        }
        lines.push(current.trimEnd());
        current = ctx.measureText(chunk).width > maxWidth ? pushLongChunk(chunk) : chunk.trimStart();
    }
    if (current) lines.push(current.trimEnd());
    return lines;
}

function wrapText(ctx, text, maxWidth) {
    return String(text || '')
        .split('\n')
        .flatMap(line => wrapTextLine(ctx, line, maxWidth));
}

function drawTextLines(ctx, lines, x, y, lineHeight, fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.textBaseline = 'top';
    for (const line of lines) {
        ctx.fillText(line, x, y);
        y += lineHeight;
    }
    return y;
}

function drawImageContain(ctx, source, x, y, width, height, mirrored = false) {
    const sourceWidth = source.videoWidth || source.width;
    const sourceHeight = source.videoHeight || source.height;
    if (!sourceWidth || !sourceHeight) return;

    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = x + (width - drawWidth) / 2;
    const drawY = y + (height - drawHeight) / 2;

    ctx.save();
    if (mirrored) {
        ctx.translate(drawX + drawWidth, drawY);
        ctx.scale(-1, 1);
        ctx.drawImage(source, 0, 0, drawWidth, drawHeight);
    } else {
        ctx.drawImage(source, drawX, drawY, drawWidth, drawHeight);
    }
    ctx.restore();
}

function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('PNG blob could not be created'));
        }, 'image/png');
    });
}

async function copyDebugScreenshotToClipboard() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('image clipboard is not supported');
    }

    const bodyStyle = getComputedStyle(document.body);
    const width = Math.max(
        320,
        Math.ceil(el.cameraSection?.getBoundingClientRect().width || 0),
        Math.ceil(el.gestureSection?.getBoundingClientRect().width || 0),
        Math.ceil(document.body.clientWidth || 0)
    );
    const scale = Math.max(1, Math.min(DEBUG_SCREENSHOT_SCALE, window.devicePixelRatio || 1));
    const sectionPadX = 12;
    const sectionPadY = 10;
    const titleHeight = 14;
    const gap = 6;
    const borderColor = cssVar('--color-border') || '#d0d0d8';
    const bgColor = cssVar('--color-bg') || '#f5f5f8';
    const textColor = cssVar('--color-text') || '#1a1a2e';
    const mutedColor = cssVar('--color-text-dim') || '#777';
    const logBg = cssVar('--color-log-bg') || '#f0f0f0';
    const logText = cssVar('--color-log-text') || '#555';

    const cameraWidth = width - sectionPadX * 2;
    const cameraRect = el.cameraContainer?.getBoundingClientRect();
    const cameraHeight = cameraRect?.width
        ? cameraWidth * (cameraRect.height / cameraRect.width)
        : cameraWidth * 9 / 16;

    const gestureWidth = width - sectionPadX * 2;
    const gestureHeight = 72;
    const wakeText = el.wakeHint && !el.wakeHint.classList.contains('is-hidden')
        ? el.wakeHint.textContent.trim()
        : '';
    const debugText = el.okDebugPanel?.textContent || 'SIGN_DEBUG\nhand=none';

    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    measureCtx.font = `10px ${bodyStyle.fontFamily}`;
    const wakeLines = wakeText ? wrapText(measureCtx, wakeText, gestureWidth - 20) : [];
    const wakeHeight = wakeLines.length ? wakeLines.length * 16 + 20 : 0;
    measureCtx.font = `10px 'Cascadia Code', 'Fira Code', monospace`;
    const debugLines = wrapText(measureCtx, debugText, gestureWidth - 12);
    const debugHeight = debugLines.length * 14.5 + 12;

    const cameraSectionHeight = sectionPadY + titleHeight + gap + cameraHeight + sectionPadY;
    const gestureSectionHeight =
        sectionPadY + titleHeight + gap + gestureHeight +
        (wakeHeight ? gap + wakeHeight : 0) +
        gap + debugHeight + sectionPadY;
    const height = Math.ceil(cameraSectionHeight + gestureSectionHeight);

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    let y = sectionPadY;
    ctx.font = `11px ${bodyStyle.fontFamily}`;
    ctx.fillStyle = mutedColor;
    ctx.textBaseline = 'top';
    ctx.fillText(document.querySelector('#camera-section .section-title')?.textContent || msg('sectionHandTracking'), sectionPadX, y);
    y += titleHeight + gap;

    fillRoundedRect(ctx, sectionPadX, y, cameraWidth, cameraHeight, 4, cssVar('--color-camera-bg') || '#000');
    ctx.save();
    roundedPath(ctx, sectionPadX, y, cameraWidth, cameraHeight, 4);
    ctx.clip();
    const mirrored = el.handCanvas?.style.transform.includes('scaleX');
    try {
        if (el.cameraVideo?.style.opacity !== '0') {
            drawImageContain(ctx, el.cameraVideo, sectionPadX, y, cameraWidth, cameraHeight, mirrored);
        }
        if (el.handCanvas) {
            drawImageContain(ctx, el.handCanvas, sectionPadX, y, cameraWidth, cameraHeight, mirrored);
        }
    } catch (_) {}
    ctx.restore();
    y += cameraHeight + sectionPadY;
    ctx.fillStyle = borderColor;
    ctx.fillRect(0, y, width, 1);

    y += sectionPadY;
    ctx.font = `11px ${bodyStyle.fontFamily}`;
    ctx.fillStyle = mutedColor;
    ctx.fillText(document.querySelector('#gesture-section .section-title')?.textContent || msg('sectionCurrentSign'), sectionPadX, y);
    y += titleHeight + gap;

    const gestureStyle = getComputedStyle(el.gestureDisplay);
    fillRoundedRect(ctx, sectionPadX, y, gestureWidth, gestureHeight, 8, gestureStyle.backgroundColor || cssVar('--color-neutral-bg') || '#333');
    ctx.textAlign = 'center';
    ctx.font = `32px ${bodyStyle.fontFamily}`;
    ctx.fillStyle = textColor;
    ctx.fillText(el.gestureEmoji?.textContent || '', sectionPadX + gestureWidth / 2, y + 10);
    ctx.font = `11px ${bodyStyle.fontFamily}`;
    ctx.fillStyle = cssVar('--color-text-muted') || '#555';
    ctx.fillText(el.gestureName?.textContent || '', sectionPadX + gestureWidth / 2, y + 50);
    ctx.textAlign = 'start';
    y += gestureHeight;

    if (wakeHeight) {
        y += gap;
        fillRoundedRect(ctx, sectionPadX, y, gestureWidth, wakeHeight, 6, cssVar('--color-surface-2') || '#f0f0f4');
        ctx.font = `10px ${bodyStyle.fontFamily}`;
        drawTextLines(ctx, wakeLines, sectionPadX + 10, y + 10, 16, cssVar('--color-text-muted') || '#555');
        y += wakeHeight;
    }

    y += gap;
    fillRoundedRect(ctx, sectionPadX, y, gestureWidth, debugHeight, 4, logBg, borderColor);
    ctx.font = `10px 'Cascadia Code', 'Fira Code', monospace`;
    drawTextLines(ctx, debugLines, sectionPadX + 6, y + 6, 14.5, logText);

    const blob = await canvasToPngBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/* ============================================================
 * カメラ検出 — 全カメラ対応、電気メガネ自動優先選択
 * ============================================================
 * chrome-extension:// では enumerateDevices() のラベルが空。
 * カメラ権限を取得済みならラベルが見えるのでポーリング + devicechange で検出、
 * 未取得なら「カメラ開始」ボタンで getUserMedia → 権限取得 → 検出。
 */

function startCameraPolling() {
    stopCameraPolling();
    checkCamera();
    cameraPollId = setInterval(checkCamera, CAMERA_POLL_INTERVAL);
}

function stopCameraPolling() {
    if (cameraPollId) { clearInterval(cameraPollId); cameraPollId = null; }
}

async function checkCamera() {
    const seq = ++cameraCheckSeq;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (seq !== cameraCheckSeq) return; // 後発の呼び出しが先に完了 → 破棄

        let videoCams = CameraRuntime.annotateCameraDevices(
            devices.filter(d => d.kind === 'videoinput'),
            xrealCameraProfiles
        );

        if (videoCams.length === 0) {
            availableCameras = [];
            updateCameraStatus('none');
            return;
        }

        const hasLabels = videoCams.some(d => d.label.length > 0);
        if (!hasLabels) {
            availableCameras = videoCams;
            updateCameraStatus('permission');
            return;
        }

        videoCams = await probeXrealCameraProfiles(videoCams, seq);
        if (seq !== cameraCheckSeq) return;

        availableCameras = videoCams;
        populateCameraSelect(videoCams);

        const hasXreal = videoCams.some(d => CameraRuntime.isXrealCamera(d));
        const xrealJustConnected = hasXreal && !hadXrealCamera;
        const xrealJustDisconnected = !hasXreal && hadXrealCamera;
        hadXrealCamera = hasXreal;

        // 電気メガネカメラが新しく接続 → カメラ未稼働なら自動選択
        if (xrealJustConnected && !activeCameraId) {
            const xreal = findXrealCameraByProfile(videoCams, selectedXrealCameraProfile)
                || preferredXrealCamera(videoCams);
            if (xreal && selectedCameraId !== xreal.deviceId) {
                prevSelectedBeforeXreal = selectedCameraId;
                selectedCameraId = xreal.deviceId;
                $('sel-camera').value = selectedCameraId;
                saveSelectedCamera();
                log(msg('logXrealDetected'));
            }
        }

        // 電気メガネカメラが切断 → 前のカメラに戻す
        if (xrealJustDisconnected && prevSelectedBeforeXreal) {
            if (videoCams.find(d => d.deviceId === prevSelectedBeforeXreal)) {
                selectedCameraId = prevSelectedBeforeXreal;
            } else if (videoCams.length > 0) {
                selectedCameraId = videoCams[0].deviceId;
            }
            prevSelectedBeforeXreal = null;
            $('sel-camera').value = selectedCameraId;
            saveSelectedCamera();
        }

        // 有効な選択が無ければ自動選択（電気メガネ優先）
        if (!selectedCameraId || !videoCams.find(d => d.deviceId === selectedCameraId)) {
            const xreal = findXrealCameraByProfile(videoCams, selectedXrealCameraProfile)
                || preferredXrealCamera(videoCams);
            selectedCameraId = xreal ? xreal.deviceId : videoCams[0].deviceId;
            $('sel-camera').value = selectedCameraId;
            saveSelectedCamera();
        }

        updateCameraStatus('ready');
    } catch (_) {}
}

async function probeXrealCameraProfiles(cameras, seq) {
    if (activeCameraId || cameraStream) return cameras;
    const targets = cameras.filter(camera =>
        CameraRuntime.isXrealCamera(camera) && !CameraRuntime.xrealCameraProfile(camera)
    );
    if (targets.length === 0) return cameras;

    let changed = false;
    for (const camera of targets) {
        try {
            const profile = await CameraRuntime.probeXrealCameraProfile(camera.deviceId);
            if (seq !== cameraCheckSeq) return cameras;
            if (profile) {
                xrealCameraProfiles[camera.deviceId] = profile;
                changed = true;
            }
        } catch (_) {
            // 実測できない場合は起動時のフォールバックに任せる。
        }
    }
    return changed ? CameraRuntime.annotateCameraDevices(cameras, xrealCameraProfiles) : cameras;
}

/** カメラドロップダウンを更新（差分がある場合のみ再構築） */
function populateCameraSelect(cameras) {
    const sel = $('sel-camera');
    const hasXreal = cameras.some(c => CameraRuntime.isXrealCamera(c));
    // 電気メガネ未検出時は EyeCon 誘導を含めた ID で差分比較
    const newIds = cameras
        .map(c => `${c.deviceId}:${c.xrealCameraProfile || ''}`)
        .join(',') + (hasXreal ? '' : ',__eyecon__');
    if (sel.dataset.cameraIds === newIds) return;
    sel.dataset.cameraIds = newIds;

    sel.innerHTML = '';
    for (const cam of cameras) {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        const prefix = CameraRuntime.isXrealCamera(cam) ? '🕶️ ' : '📷 ';
        const label = cameraOptionLabel(cam, cameras.indexOf(cam));
        opt.textContent = prefix + label;
        sel.appendChild(opt);
    }

    // 電気メガネカメラ未検出時、EyeCon 誘導オプションを追加
    if (!hasXreal) {
        const opt = document.createElement('option');
        opt.value = EYECON_VALUE;
        opt.textContent = msg('optionEyeconSetup');
        sel.appendChild(opt);
    }

    // 選択を復元
    if (cameras.some(c => c.deviceId === selectedCameraId)) {
        sel.value = selectedCameraId;
    }
}

function preferredXrealCamera(cameras) {
    return findXrealCameraByProfile(cameras, CameraRuntime.XREAL_CAMERA_PROFILE_RGB)
        || cameras.find(camera => CameraRuntime.isXrealCamera(camera))
        || null;
}

function findXrealCameraByProfile(cameras, profile) {
    const normalized = CameraRuntime.normalizeXrealCameraProfile(profile);
    if (!normalized) return null;
    return cameras.find(camera => CameraRuntime.xrealCameraProfile(camera) === normalized) || null;
}

function cameraOptionLabel(camera, index) {
    if (!CameraRuntime.isXrealCamera(camera)) {
        return camera.label || msg('cameraFallbackName', [String(index + 1)]);
    }
    const profile = CameraRuntime.xrealCameraProfile(camera);
    if (profile === CameraRuntime.XREAL_CAMERA_PROFILE_MONO) {
        return msg('xrealCameraUvc1Label');
    }
    if (profile === CameraRuntime.XREAL_CAMERA_PROFILE_RGB) {
        return msg('xrealCameraUvc0Label');
    }
    return msg('xrealCameraUnknownLabel', [String(index + 1)]);
}

function updateCameraStatus(state) {
    const isRunning = activeCameraId !== null;
    const sel = $('sel-camera');

    switch (state) {
        case 'ready':
            hide(el.setupHint);
            show(el.gestureSection);
            show(el.cameraControls);
            sel.disabled = isRunning;
            if (!isRunning) {
                el.btnStartCam.disabled = false;
                el.btnStartCam.textContent = sel.value === EYECON_VALUE
                    ? msg('btnOpenEyecon') : msg('btnStartCamera');
            }
            break;
        case 'permission':
            el.setupHint.innerHTML = msg('hintPermissionRequired');
            show(el.setupHint);
            show(el.gestureSection);
            show(el.cameraControls);
            sel.disabled = true;
            if (!isRunning) {
                el.btnStartCam.disabled = false;
                el.btnStartCam.textContent = msg('btnRequestPermission');
            }
            bindExtSettingsLink();
            break;
        default: // 'none'
            el.setupHint.innerHTML = msg('hintNoCamera');
            show(el.setupHint);
            hide(el.cameraSection);
            hide(el.gestureSection);
            hide(el.cameraControls);
            rebindEyeconLink();
    }
}

function rebindEyeconLink() {
    const link = document.getElementById('link-eyecon');
    if (link) link.onclick = openEyecon;
}

function bindExtSettingsLink() {
    const link = document.getElementById('link-ext-settings');
    if (link) {
        link.onclick = (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        };
    }
}

function openEyecon(e) {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://megane.8796.jp/eyecon/' });
}

function saveSelectedCamera() {
    const selectedCamera = selectedCameraDevice();
    const profile = CameraRuntime.xrealCameraProfile(selectedCamera);
    if (profile) {
        selectedXrealCameraProfile = profile;
    } else if (selectedCamera) {
        selectedXrealCameraProfile = null;
    }
    try {
        chrome.storage.local.set({
            selectedCameraId,
            selectedXrealCameraProfile: selectedXrealCameraProfile || '',
        });
    } catch (_) {}
}

function updateSelectedXrealCameraProfile(profile, options = {}) {
    const normalized = CameraRuntime.normalizeXrealCameraProfile(profile);
    if (!normalized || !selectedCameraId) return;

    selectedXrealCameraProfile = normalized;
    xrealCameraProfiles[selectedCameraId] = normalized;
    availableCameras = availableCameras.map(camera =>
        camera.deviceId === selectedCameraId
            ? { ...camera, xrealCameraProfile: normalized }
            : camera
    );
    populateCameraSelect(availableCameras);
    const sel = $('sel-camera');
    if (sel) sel.value = selectedCameraId;
    if (options.save !== false) saveSelectedCamera();
}

function selectedCameraDevice() {
    return availableCameras.find(camera => camera.deviceId === selectedCameraId) || null;
}

function currentCameraHint() {
    const selectedCamera = selectedCameraDevice();
    if (CameraRuntime.isXrealCamera(selectedCamera)) return selectedCamera;
    const activeTrack = CameraRuntime.primaryVideoTrack(cameraStream);
    return activeTrack
        || selectedCamera
        || CameraRuntime.xrealCameraHint(selectedXrealCameraProfile);
}

function currentCameraRequestOptions(cameraHint = currentCameraHint()) {
    return CameraRuntime.requestOptionsForInferenceResolution(inferenceResolution, cameraHint);
}

function selectedCameraLogLabel() {
    const camera = selectedCameraDevice();
    return camera?.label || msg('cameraFallbackName', ['?']);
}

function cameraProfileLogLabel(cameraHint) {
    const profile = CameraRuntime.xrealCameraProfile(cameraHint);
    if (profile === CameraRuntime.XREAL_CAMERA_PROFILE_RGB) return msg('xrealCameraUvc0Label');
    if (profile === CameraRuntime.XREAL_CAMERA_PROFILE_MONO) return msg('xrealCameraUvc1Label');
    if (CameraRuntime.isXrealCamera(cameraHint)) return msg('xrealCameraLabel');
    return '-';
}

/* ============================================================
 * カメラ制御
 * ============================================================ */
async function startCamera() {
    cameraRestartController.cancel();
    // EyeCon 誘導が選択されている場合はセットアップページを開く
    if ($('sel-camera').value === EYECON_VALUE) {
        chrome.tabs.create({ url: 'https://megane.8796.jp/eyecon/' });
        return;
    }
    try {
        el.btnStartCam.disabled = true;
        el.btnStartCam.textContent = msg('btnCameraLoading');

        // MediaPipe ロード（初回のみ）
        if (!tracker.loaded) {
            await tracker.loadModel((key) => log(msg(key)));
        }

        const cameraHint = currentCameraHint();
        const requestOptions = currentCameraRequestOptions(cameraHint);
        log(msg('logCameraSelected', [selectedCameraLogLabel(), cameraProfileLogLabel(cameraHint)]));
        log(msg('logCameraRequesting', [CameraRuntime.formatRequestOptions(requestOptions)]));
        const cameraResult = await CameraRuntime.requestTrackingCameraStream(
            selectedCameraId,
            requestOptions
        );
        cameraStream = cameraResult.stream;

        const track = cameraResult.track;
        activeCameraId = CameraRuntime.cameraDeviceId(cameraStream);
        selectedXrealCameraProfile = CameraRuntime.xrealCameraProfile(track) || selectedXrealCameraProfile;
        updateSelectedXrealCameraProfile(selectedXrealCameraProfile);
        logXrealCameraFallback(cameraResult);
        log(msg('logCameraAcquired', [track?.label || 'Camera']));
        logCameraResolution(cameraResult.requestOptions, track);

        applyXrealMirrorAuto(track);

        // 権限取得直後（selectedCameraId 未設定）: カメラリストを構築して選択反映
        if (!selectedCameraId) {
            await checkCamera();
            selectedCameraId = activeCameraId;
            const sel = $('sel-camera');
            if (sel) sel.value = selectedCameraId;
            saveSelectedCamera();
        }

        // トラック終了監視 — USB抜けなどで自動停止
        track?.addEventListener('ended', () => {
            log(msg('logCameraDisconnected'));
            stopCamera();
        });

        await CameraRuntime.attachStreamToVideo(el.cameraVideo, cameraStream);

        applySkeletonOnly(el.chkSkeleton.checked);
        await tracker.start(el.cameraVideo, el.handCanvas, {
            skeletonOnly: el.chkSkeleton.checked,
        });
        logInferenceResolution();

        // 認識インスタンスの所有権を要求（他インスタンスを停止させる）
        takenOver = false;
        await chrome.runtime.sendMessage({
            type: 'claim-active-instance',
            instanceId,
            instanceType: 'sidepanel',
            windowId: (await chrome.windows.getCurrent()).id,
        }).catch(() => {});

        hide(el.btnStartCam);
        show(el.btnStopCam);
        show($('btn-pip'));
        $('sel-camera').disabled = true;
        show(el.cameraSection);
        stopCameraPolling();
        pointerVisibilityController?.sync();
        log(msg('logCameraStarted'));

        // チュートリアル: カメラ起動でステップ自動進行
        if (tutorialActive && tutorialCurrentStep().autoAdvanceOn === 'camera-started') {
            advanceTutorial();
        }
    } catch (e) {
        const errMsg = e?.message || e?.name || String(e);
        tracker.stop();
        cameraStream = CameraRuntime.releaseCameraStream(cameraStream, el.cameraVideo);
        if (e?.name === 'NotAllowedError') {
            showCameraPermissionHint();
        } else if (e?.name === 'OverconstrainedError') {
            log(msg('logCameraConstraintError'));
            selectedCameraId = null;
            startCameraPolling();
        } else {
            logCameraAttemptErrors(e);
            log(msg('logCameraError', [errMsg]));
        }
        console.error('[GW] Camera error:', e);
        activeCameraId = null;
        el.btnStartCam.disabled = false;
        el.btnStartCam.textContent = msg('btnStartCamera');
    }
}

function applyXrealMirrorAuto(track) {
    if (!CameraRuntime.isXrealCamera(track)) return;
    if (savedMirrorState === null) {
        savedMirrorState = el.chkMirror.checked;
    }
    if (el.chkMirror.checked) {
        el.chkMirror.checked = false;
        applyMirror(false);
        log(msg('logXrealMirrorAuto'));
    }
}

function scheduleCameraRestartForSettings() {
    cameraRestartController.schedule();
}

async function restartCameraForSettings() {
    if (!cameraStream) return;
    const seq = cameraRestartController.nextSeq();
    log(msg('logCameraRestartingForSettings'));
    const previousStream = cameraStream;
    activeCameraId = null;

    try {
        const cameraHint = currentCameraHint();
        const requestOptions = currentCameraRequestOptions(cameraHint);
        log(msg('logCameraSelected', [selectedCameraLogLabel(), cameraProfileLogLabel(cameraHint)]));
        log(msg('logCameraRequesting', [CameraRuntime.formatRequestOptions(requestOptions)]));
        const result = await CameraRuntime.restartTrackingCamera({
            currentStream: previousStream,
            videoEl: el.cameraVideo,
            tracker,
            canvasEl: el.handCanvas,
            cameraId: selectedCameraId,
            requestOptions,
            trackerOptions: { skeletonOnly: el.chkSkeleton.checked },
            isCurrent: () => cameraRestartController.isCurrent(seq),
            beforeStop: () => {
                stopAllGestureActions();
                pointerVisibilityController?.stop({ hide: true });
                resetMetaGestureState();
                setGestureText('—', '');
            },
            beforeStart: ({ track }) => {
                applyXrealMirrorAuto(track);
                applySkeletonOnly(el.chkSkeleton.checked);
            },
        });
        if (result.stale) return;

        cameraStream = result.stream;
        const track = result.track;
        activeCameraId = CameraRuntime.cameraDeviceId(cameraStream);
        selectedXrealCameraProfile = CameraRuntime.xrealCameraProfile(track) || selectedXrealCameraProfile;
        updateSelectedXrealCameraProfile(selectedXrealCameraProfile);
        logXrealCameraFallback(result);
        log(msg('logCameraAcquired', [track?.label || 'Camera']));
        logCameraResolution(result.requestOptions, track);

        track?.addEventListener('ended', () => {
            log(msg('logCameraDisconnected'));
            stopCamera();
        });

        logInferenceResolution();
        pointerVisibilityController?.sync();
        log(msg('logCameraRestartedForSettings'));
    } catch (e) {
        const errMsg = e?.message || e?.name || String(e);
        logCameraAttemptErrors(e);
        log(msg('logCameraError', [errMsg]));
        console.error('[GW] Camera restart error:', e);
        cameraStream = CameraRuntime.releaseCameraStream(cameraStream, el.cameraVideo);
        show(el.btnStartCam);
        el.btnStartCam.disabled = false;
        el.btnStartCam.textContent = msg('btnStartCamera');
        hide(el.btnStopCam);
        hide($('btn-pip'));
        hide(el.cameraSection);
        activeCameraId = null;
        $('sel-camera').disabled = false;
        startCameraPolling();
    }
}

/** セットアップページを開いたかどうか（無限ループ防止） */
let setupPageOpened = false;

function showCameraPermissionHint() {
    log(msg('logCameraPermissionRequired'));

    // 初回のみセットアップページを自動で開く
    if (!setupPageOpened) {
        setupPageOpened = true;
        log(msg('logCameraPermissionViaSetup'));
        chrome.tabs.create({ url: chrome.runtime.getURL('src/camera/camera-setup.html') });
    } else {
        log(msg('logCameraPermissionInstructions'));
    }

    updateCameraStatus('permission');
}

// セットアップページからの許可通知を受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'camera-permission-granted') {
        log(msg('logCameraPermissionReceived'));
        setupPageOpened = false;
        // storage のフラグをクリア
        chrome.storage.local.remove('cameraPermissionReady');
        // カメラを再開始
        startCamera();
        sendResponse({ ok: true });
    }
    return false;
});

// storage 経由のバックアップ通知（サイドパネルが再読込された場合）
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cameraPermissionReady?.newValue === true) {
        log(msg('logCameraPermissionReceived'));
        setupPageOpened = false;
        chrome.storage.local.remove('cameraPermissionReady');
        startCamera();
    }
    // ポップアップ閉じ→カメラ自動復帰（SW がフラグを設定）
    if (area === 'session' && changes.pipReturnToSidepanel?.newValue) {
        const flag = changes.pipReturnToSidepanel.newValue;
        chrome.storage.session.remove('pipReturnToSidepanel');
        // PiP ポップアップ UI をリセット
        if (pipWindowId) {
            pipWindowId = null;
            pipTargetTabId = null;
            chrome.storage.session.remove('pipState');
            hide($('pip-active-section'));
            show(el.cameraControls);
        }
        if (flag.cameraId) selectedCameraId = flag.cameraId;
        log(msg('logPipReturned'));
        startCamera();
    }
});

function stopCamera() {
    cameraRestartController.cancel();
    stopAllGestureActions();
    pointerVisibilityController?.stop({ hide: true });
    // PiP ポップアップが開いている場合は閉じる
    if (pipWindowId) {
        chrome.windows.remove(pipWindowId).catch(() => {});
        pipWindowId = null;
        pipTargetTabId = null;
        chrome.storage.session.remove('pipState');
    }
    tracker.stop();
    cameraStream = CameraRuntime.releaseCameraStream(cameraStream, el.cameraVideo);
    show(el.btnStartCam);
    el.btnStartCam.disabled = false;
    el.btnStartCam.textContent = msg('btnStartCamera');
    hide(el.btnStopCam);
    hide($('btn-pip'));
    hide(el.cameraSection);
    // メタサイン状態もリセット
    resetMetaGestureState();
    setGestureText('—', '');
    // メガネカメラによるミラー自動OFFの復元
    if (savedMirrorState !== null) {
        el.chkMirror.checked = savedMirrorState;
        applyMirror(savedMirrorState);
        savedMirrorState = null;
    }
    activeCameraId = null;
    $('sel-camera').disabled = false;
    startCameraPolling();
    // 所有権を解放（テイクオーバーによる停止でなければ）
    if (!takenOver) {
        chrome.runtime.sendMessage({ type: 'release-active-instance', instanceId }).catch(() => {});
    }
}

/* ============================================================
 * PiP (Picture-in-Picture) モード
 * ============================================================
 * 独立したポップアップウィンドウ (src/pip/pip.html) でカメラ＋ハンドトラッキングを
 * 実行し、標準 Video PiP API で常に最前面のフロートウィンドウを表示する。
 * トップレベルウィンドウなので PiP API が確実に動作する。
 * サイドパネルを閉じても PiP は継続する。
 */

/** PiP ポップアップウィンドウを開く */
async function openPipWindow() {
    if (pipWindowId) return;

    const btnPip = $('btn-pip');
    btnPip.disabled = true;

    try {
        // アクティブタブ ID を取得（ジェスチャーアクションの送信先）
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        pipTargetTabId = activeTab?.id || null;

        // サイドパネルが属するブラウザウィンドウ ID を取得
        const currentWindow = await chrome.windows.getCurrent();
        const browserWindowId = currentWindow.id;

        // カメラ ID を保存してからサイドパネルのカメラを停止
        const cameraId = activeCameraId;
        const cameraTrack = CameraRuntime.primaryVideoTrack(cameraStream);
        const xrealCamera = CameraRuntime.isXrealCamera(cameraTrack);
        const xrealCameraProfile = xrealCamera
            ? (CameraRuntime.xrealCameraProfile(cameraTrack)
                || CameraRuntime.xrealCameraProfile(selectedCameraDevice())
                || selectedXrealCameraProfile)
            : null;

        // サイドパネルの認識インスタンス所有権を先に解放
        // （ポップアップが claim した時にテイクオーバーが発生しないようにする）
        await chrome.runtime.sendMessage({
            type: 'release-active-instance',
            instanceId,
        }).catch(() => {});

        cameraRestartController.cancel();
        stopAllGestureActions();
        pointerVisibilityController?.stop({ hide: true });
        tracker.stop();
        cameraStream = CameraRuntime.releaseCameraStream(cameraStream, el.cameraVideo);
        activeCameraId = null;
        hide(el.cameraSection);
        hide($('btn-pip'));
        hide(el.btnStopCam);

        // ポップアップウィンドウを画面右上に作成
        const params = new URLSearchParams({
            camera: cameraId || '',
            xrealCamera: xrealCamera ? '1' : '0',
            xrealCameraProfile: xrealCameraProfile || '',
            targetTab: String(pipTargetTabId || ''),
            windowId: String(browserWindowId),
        });
        const popupWidth = 400;
        const popupHeight = 320;
        const screenW = currentWindow.width || screen.availWidth;
        const screenLeft = currentWindow.left || 0;
        const screenTop = currentWindow.top || 0;
        const pipUrl = `${chrome.runtime.getURL('src/pip/pip.html')}?${params}`;
        const pip = await chrome.windows.create({
            type: 'popup',
            url: pipUrl,
            width: popupWidth,
            height: popupHeight,
            left: screenLeft + screenW - popupWidth,
            top: screenTop,
            focused: true,
        });
        pipWindowId = pip.id;
        const capturedPipId = pip.id;

        // PiP 状態を永続化
        chrome.storage.session.set({
            pipState: { windowId: pipWindowId, targetTabId: pipTargetTabId, cameraId, xrealCameraProfile, browserWindowId },
        });

        // ウィンドウ閉鎖を監視
        const onRemoved = (windowId) => {
            if (windowId === capturedPipId) {
                chrome.windows.onRemoved.removeListener(onRemoved);
                pipWindowId = null;
                pipTargetTabId = null;
                chrome.storage.session.remove('pipState');
                hide($('pip-active-section'));
                show(el.cameraControls);
                show(el.btnStartCam);
                el.btnStartCam.disabled = false;
                el.btnStartCam.textContent = msg('btnStartCamera');
                log(msg('logPipExit'));
            }
        };
        chrome.windows.onRemoved.addListener(onRemoved);

        // UI: PiP アクティブ表示
        show($('pip-active-section'));
        log(msg('logPipEnter'));

        // サイドパネルを自動で閉じる（Chrome 129+）
        try {
            await chrome.sidePanel.close({ windowId: browserWindowId });
        } catch (_) {
            // close() 未対応の場合はサイドパネルを開いたまま
        }

    } catch (e) {
        log(msg('logPipError', [e?.message || String(e)]));
        console.error('[GW] PiP window error:', e);
        show(el.btnStartCam);
        el.btnStartCam.disabled = false;
    } finally {
        btnPip.disabled = false;
    }
}

/** PiP ポップアップが閉じたときの通知 / 単一インスタンス制御を受信 */
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'pip-closed') {
        if (pipWindowId) {
            pipWindowId = null;
            pipTargetTabId = null;
            chrome.storage.session.remove('pipState');
            hide($('pip-active-section'));
            show(el.cameraControls);
            show(el.btnStartCam);
            el.btnStartCam.disabled = false;
            el.btnStartCam.textContent = msg('btnStartCamera');
        }
    }
    // 単一インスタンス制御: 別のインスタンスに所有権が移った
    if (message.type === 'instance-takeover' && message.instanceId !== instanceId) {
        takenOver = true;
        cameraRestartController.cancel();
        stopAllGestureActions();
        pointerVisibilityController?.stop({ hide: true });
        // カメラを停止（PiP ポップアップも含む）
        if (pipWindowId) {
            chrome.windows.remove(pipWindowId).catch(() => {});
            pipWindowId = null;
            pipTargetTabId = null;
            chrome.storage.session.remove('pipState');
        }
        tracker.stop();
        cameraStream = CameraRuntime.releaseCameraStream(cameraStream, el.cameraVideo);
        activeCameraId = null;
        // UI を「別ウィンドウで実行中」表示に切替
        hide(el.cameraSection);
        hide($('pip-active-section'));
        hide(el.btnStopCam);
        hide($('btn-pip'));
        show(el.btnStartCam);
        el.btnStartCam.disabled = false;
        el.btnStartCam.textContent = msg('btnStartCamera');
        log(msg('logOtherWindowStarted'));
    }
});

/* ============================================================
 * ジェスチャー表示ヘルパー
 * ============================================================ */

/** サイドパネルのジェスチャー表示テキストを更新 */
function setGestureText(emoji, name, options = {}) {
    pageActionStatusVisible = options.pageActionStatus === true;
    el.gestureEmoji.textContent = emoji;
    el.gestureName.textContent = name;
}

function clearPageActionStatus() {
    if (!pageActionStatusVisible) return;
    setGestureText('—', '');
}


/* ============================================================
 * 効果音（Web Audio API でビープ音生成）
 * ============================================================ */
const beepPlayer = NotificationSound.createBeepPlayer({
    getVolume: () => notifyVolume,
});
function playBeep(freq = 880, duration = 0.12) {
    beepPlayer.play(freq, duration);
}

/* ============================================================
 * 操作モード
 * ============================================================ */
function normalizeOperationMode(mode) {
    return GestureRuntimeUtils.normalizeOperationMode(mode);
}

function availableOperationModes() {
    return GestureRuntimeUtils.availableOperationModes();
}

function getMappingForMode(mode) {
    if (mode === OPERATION_MODES.BROWSER) return browserMapping;
    if (mode === OPERATION_MODES.POINTER) return pointerMapping;
    return mediaMapping;
}

function getActionKeysForMode(mode) {
    if (mode === OPERATION_MODES.BROWSER) return BROWSER_ACTION_KEYS;
    if (mode === OPERATION_MODES.POINTER) return POINTER_ACTION_KEYS;
    return MEDIA_ACTION_KEYS;
}

function refreshCurrentMapping() {
    operationMode = normalizeOperationMode(operationMode);
    currentMapping = getMappingForMode(operationMode);
}

function updateOperationModeUI() {
    refreshCurrentMapping();
    document.body.classList.toggle('mode-media', operationMode === OPERATION_MODES.MEDIA);
    document.body.classList.toggle('mode-browser', operationMode === OPERATION_MODES.BROWSER);
    document.body.classList.toggle('mode-pointer', operationMode === OPERATION_MODES.POINTER);
    if (el.operationModeLabel) {
        el.operationModeLabel.textContent = GestureRuntimeUtils.modeLabel(operationMode);
        el.operationModeLabel.title = controlEnabled ? msg('titleOperationToggle') : msg('titleOperationToggleOff');
    }
    if (el.chkEnabled) el.chkEnabled.checked = controlEnabled;
    document.querySelectorAll('.mode-tab').forEach((tab) => {
        tab.classList.toggle('is-active', tab.dataset.mode === operationMode);
        tab.setAttribute('aria-selected', tab.dataset.mode === operationMode ? 'true' : 'false');
        tab.tabIndex = 0;
    });
}

function setOperationMode(mode, options = {}) {
    const previousMode = operationMode;
    const nextMode = normalizeOperationMode(mode);
    if (operationMode === nextMode && !options.force) {
        updateOperationModeUI();
        pointerVisibilityController?.sync(previousMode);
        return;
    }
    stopAllGestureActions();
    continuousGestureGate?.reset();
    operationMode = nextMode;
    updateOperationModeUI();
    if (options.save !== false) chrome.storage.sync.set({ operationMode });
    if (options.log !== false) log(msg('logOperationModeChanged', [GestureRuntimeUtils.modeLabel(operationMode)]));
    if (options.beep !== false) playBeep(GestureRuntimeUtils.modeBeepFrequency(operationMode), 0.18);
    pointerVisibilityController?.sync(previousMode);
    buildMappingUI();
    buildMetaMappingUI();
}

function toggleOperationMode() {
    const modes = availableOperationModes();
    const index = Math.max(0, modes.indexOf(operationMode));
    setOperationMode(modes[(index + 1) % modes.length]);
}

/* ============================================================
 * ウェイクサイン状態マシン
 * ============================================================ */
function setWakeState(newState) {
    wakeState = newState;
    updateTrackerFps();
    if (wakeTimeout) { clearTimeout(wakeTimeout); wakeTimeout = null; }
    cancelPendingAction();
    stopDirectionalScroll();
    stopPointerMove();
    stopRepeat();

    const gd = el.gestureDisplay;
    if (!gd) return;

    // 状態クラスをリセットして適切なクラスを付与
    gd.classList.remove('state-idle', 'state-active', 'state-always');

    switch (newState) {
        case WAKE_STATE.IDLE:
            gd.classList.add(wakeGestureType === 'none' ? 'state-always' : 'state-idle');
            break;
        case WAKE_STATE.ACTIVE:
            gd.classList.add('state-active');
            playBeep(880, 0.15);
            wakeTimeout = setTimeout(() => {
                setWakeState(WAKE_STATE.IDLE);
                log(msg('logWakeTimeout'));
            }, wakeActiveDuration);
            // チュートリアル: ウェイク発火でステップ自動進行
            if (tutorialActive && tutorialCurrentStep().autoAdvanceOn === 'wake-activated') {
                advanceTutorial();
            }
            break;
    }
}

/** リピート中にアクティブ待機時間をリセット延長 */
function extendWakeTimeout(durationMs = wakeActiveDuration) {
    if (wakeGestureType === 'none') return;
    if (wakeTimeout) { clearTimeout(wakeTimeout); wakeTimeout = null; }
    wakeTimeout = setTimeout(() => {
        setWakeState(WAKE_STATE.IDLE);
        log(msg('logWakeTimeout'));
    }, durationMs);
}

/** 設定が有効な場合のみ、ウェイク待機中の推論FPSを落とす */
function updateTrackerFps() {
    const fps = resolveWakeInferenceFps(inferenceFps, wakeState, wakeGestureType, idleInferenceFpsEnabled);
    tracker.targetFps = pointerMoveController?.active
        ? Math.max(fps, POINTER_MOVE_ACTIVE_FPS)
        : fps;
}

function updateTrackerInferenceResolution() {
    tracker.setInferenceMaxWidth(inferenceResolutionToMaxWidth(inferenceResolution));
}

function logCameraResolution(requestOptions, track) {
    log(msg('logCameraResolution', CameraRuntime.cameraResolutionLogArgs(requestOptions, track)));
}

function logXrealCameraFallback(cameraResult) {
    if (cameraResult?.fallbackProfile === CameraRuntime.XREAL_CAMERA_PROFILE_MONO) {
        log(msg('logXrealMonoFallback'));
    }
}

function logCameraAttemptErrors(error) {
    if (!Array.isArray(error?.cameraAttemptErrors)) return;
    for (const attempt of error.cameraAttemptErrors) {
        const request = CameraRuntime.formatRequestOptions(attempt.requestOptions || {});
        const message = attempt.message || attempt.name || '-';
        log(msg('logCameraAttemptFailed', [request, message]));
    }
}

function logInferenceResolution() {
    log(msg('logInferenceResolution', CameraRuntime.inferenceResolutionLogArgs(tracker, inferenceResolution)));
}

/* ============================================================
 * ハンドサイン → アクション
 * ============================================================ */

/** 保留中のアクションをキャンセル */
function cancelPendingAction() {
    if (pendingActionTimer) { clearTimeout(pendingActionTimer); pendingActionTimer = null; }
    pendingGesture = null;
}

/** リピート停止 */
function stopRepeat() {
    if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
    repeatingGesture = null;
}

function startDirectionalScroll(gesture) {
    if (!directionalScrollController?.start(gesture, lastFrameHands)) return false;
    repeatingGesture = gesture;
    continuousGestureGate?.start(gesture);
    return true;
}

function stopDirectionalScroll() {
    directionalScrollController?.stop();
}

function updateDirectionalScroll(hands, now) {
    directionalScrollController?.update(hands, now);
}

function startPointerMove(gesture) {
    if (!pointerMoveController?.start(gesture, lastFrameHands)) return false;
    return true;
}

function stopPointerMove() {
    pointerMoveController?.stop();
}

function updatePointerMove(hands, now) {
    pointerMoveController?.update(hands, now);
}

/** holdTime 経過後にアクションを確定発火する */
function confirmAction(gesture, action) {
    if (POINTER_MOVE_ACTIONS.has(action)) {
        if (startPointerMove(gesture)) {
            setGestureText(GESTURE_ICONS[gesture] || '❓', actionDisplay(action));
            return;
        }
    }

    const now = Date.now();
    if (now - lastActionTime < ACTION_COOLDOWN) return;
    lastActionTime = now;

    log(msg('logGestureAction', [gestureLabel(gesture), actionDisplay(action)]));
    if (DIRECTIONAL_ACTIONS.has(action)) {
        if (startDirectionalScroll(gesture)) {
            setGestureText(GESTURE_ICONS[gesture] || '❓', actionDisplay(action));
            return;
        }
    }

    sendAction(action);

    // リピート対応アクション → インターバル開始（ウェイク IDLE にしない）
    if (REPEATABLE_ACTIONS.has(action) && actionRepeatInterval > 0) {
        repeatingGesture = gesture;
        continuousGestureGate?.start(gesture);
        repeatTimer = setInterval(() => {
            sendAction(action);
            // リピート中はアクティブ待機を延長
            extendWakeTimeout();
        }, actionRepeatInterval);
        return;
    }

    if (wakeGestureType !== 'none') {
        setWakeState(WAKE_STATE.IDLE);
    }
}

/** サイン変化時: 保留 + リピートを停止し、必要なら IDLE に戻す */
function stopAllGestureActions() {
    cancelPendingAction();
    const wasRepeating = repeatingGesture !== null ||
        !!directionalScrollController?.active ||
        !!directionalScrollController?.suspended ||
        !!pointerMoveController?.active ||
        !!pointerMoveController?.suspended;
    continuousGestureGate?.stop();
    stopDirectionalScroll();
    stopPointerMove();
    stopRepeat();
    if (wasRepeating && wakeGestureType !== 'none') {
        setWakeState(WAKE_STATE.IDLE);
    }
}

function isWakeGesture(gesture) {
    if (wakeGestureType === 'open') return gesture === 'open' || gesture === 'open-palm';
    return gesture === wakeGestureType;
}

tracker.addEventListener('gesture', (e) => {
    const gesture = e.detail.gesture;
    if (GestureRuntimeUtils.isUncertainGesture(gesture)) {
        if (gesture === null && okDebugEnabled && el.okDebugPanel) {
            el.okDebugPanel.textContent = 'SIGN_DEBUG\nhand=none';
        }
        if (gesture === 'unknown') {
            setGestureText(GESTURE_ICONS.unknown || '❓', gestureLabel('unknown'));
        } else {
            setGestureText('—', '');
        }
        const suspended = holdGestureResumeController?.suspend();
        if (!suspended) {
            continuousGestureGate?.reset();
            stopAllGestureActions();
        }
        // メタサイン状態もリセット（手が消えた）
        resetMetaGestureState();
        return;
    }

    setGestureText(GESTURE_ICONS[gesture] || '❓', gestureLabel(gesture));

    // メタサイン検出中は通常アクションを抑制
    if (metaGestureController?.isBlocking()) return;

    if (!controlEnabled) return;

    // ウェイクサインで ACTIVE に遷移
    if (wakeGestureType !== 'none' && isWakeGesture(gesture)) {
        continuousGestureGate?.reset();
        stopAllGestureActions();
        if (wakeState === WAKE_STATE.IDLE) {
            setWakeState(WAKE_STATE.ACTIVE);
            log(msg('logWakeActivated'));
        }
        return;
    }

    const now = Date.now();
    holdGestureResumeController?.expire(now);
    const hadSuspendedHold = !!holdGestureResumeController?.hasSuspended();
    const resumedAction = holdGestureResumeController?.resume(gesture, now);
    if (resumedAction) {
        setGestureText(GESTURE_ICONS[gesture] || '❓', actionDisplay(resumedAction));
        return;
    }
    if (hadSuspendedHold) {
        stopAllGestureActions();
        return;
    }

    const continuousGate = continuousGestureGate?.handleGestureChange(gesture, isWakeGesture);
    if (continuousGate && !continuousGate.allowAction) {
        stopAllGestureActions();
        return;
    }

    // ウェイクモード有効時: ACTIVE でなければ発火しない
    if (wakeGestureType !== 'none' && wakeState !== WAKE_STATE.ACTIVE) return;

    const action = currentMapping[gesture];
    if (!action || action === 'none') { stopAllGestureActions(); return; }

    // リピート中 or 確定待機中の同じサイン → 継続
    if (pointerMoveController?.active && gesture === pointerMoveController.state?.gesture) return;
    if (gesture === repeatingGesture || gesture === pendingGesture) return;

    // 新しいサイン → すべてリセットして確定タイマー開始
    cancelPendingAction();
    stopDirectionalScroll();
    stopPointerMove();
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

function executeMetaAction(action) {
    switch (action) {
        case 'toggleEnabled':
            setControlEnabled(!controlEnabled);
            break;
        case 'toggleMode':
            toggleOperationMode();
            break;
        case 'setModeMedia':
            setOperationMode(OPERATION_MODES.MEDIA);
            break;
        case 'setModeBrowser':
            setOperationMode(OPERATION_MODES.BROWSER);
            break;
        case 'setModePointer':
            setOperationMode(OPERATION_MODES.POINTER);
            break;
        default:
            return false;
    }
    return true;
}

function resetMetaGestureState() {
    metaGestureController?.reset();
}

function getEnabledMetaAction(type) {
    const action = metaGestureMapping[type] || 'none';
    return GestureRuntimeUtils.enabledMetaAction(action);
}

/** frame イベント: メタサインの検出と保持系操作 */
tracker.addEventListener('frame', (e) => {
    const { gestures: hands } = e.detail;
    const now = Date.now();
    lastFrameHands = hands;
    updateOkDebug(e.detail, now);
    const result = metaGestureController?.update(hands, now);
    if (result?.allowDirectional) {
        updateDirectionalScroll(hands, now);
        updatePointerMove(hands, now);
    }
});

async function sendAction(action, data) {
    try {
        const payload = { type: 'gesture-action', action };
        if (data) payload.data = data;
        if (lockedTargetTabId) payload.targetTabId = lockedTargetTabId;
        const result = await chrome.runtime.sendMessage(payload);
        if (result?.ok === false) {
            if (result.reason === 'restrictedPage' || result.reason === 'injectionBlocked') {
                setGestureText('🚫', msg('gestureBlockedPageAction'), { pageActionStatus: true });
                log(msg('logInjectionBlocked'));
            } else if (result.reason === 'reloadRequired') {
                setGestureText('🔄', msg('gestureReloadRequired'), { pageActionStatus: true });
                log(msg('logReloadRequired'));
            } else if (result.reason === 'noTargetTab') {
                setGestureText('🎯', msg('gestureNoTargetTab'), { pageActionStatus: true });
                log(msg('logNoTargetTab'));
            } else if (result.reason === 'tabActionFailed') {
                setGestureText('⚠', msg('gestureTabActionFailed'), { pageActionStatus: true });
                log(msg('logTabActionFailed', [result.message || 'unknown']));
            } else {
                log(msg('logSendError', [result.message || result.reason || 'unknown']));
            }
        } else {
            clearPageActionStatus();
        }
    } catch (e) {
        log(msg('logSendError', [e?.message || String(e)]));
    }
}

continuousGestureGate = new ContinuousGestureGate();

directionalScrollController = new DirectionalScrollController({
    tracker,
    sendAction,
    extendWakeTimeout,
    stopAllGestureActions,
    isControlEnabled: () => controlEnabled,
    getSpeedMultiplier: () => moveSpeedToMultiplier(holdScrollSpeed),
});

pointerMoveController = new PointerMoveController({
    tracker,
    sendAction,
    extendWakeTimeout,
    stopAllGestureActions,
    isControlEnabled: () => controlEnabled && operationMode === OPERATION_MODES.POINTER,
    getSpeedMultiplier: () => moveSpeedToMultiplier(pointerMoveSpeed),
    onStateChange: () => updateTrackerFps(),
});

holdGestureResumeController = new HoldGestureResumeController({
    directionalScrollController,
    pointerMoveController,
    continuousGestureGate,
    getLastFrameHands: () => lastFrameHands,
    extendWakeTimeout,
    stopRepeat,
    setWakeIdle: () => setWakeState(WAKE_STATE.IDLE),
    isWakeGestureEnabled: () => wakeGestureType !== 'none',
    getWakeActiveDuration: () => wakeActiveDuration,
    setRepeatingGesture: (gesture) => { repeatingGesture = gesture; },
});

pointerVisibilityController = new PointerVisibilityController({
    getOperationMode: () => operationMode,
    isControlEnabled: () => controlEnabled,
    hasCameraStream: () => !!cameraStream,
    sendAction,
});

metaGestureController = new MetaGestureController({
    getMetaAction: getEnabledMetaAction,
    getHoldMs: () => Math.max(gestureHoldTime, 200),
    executeMetaAction: (_type, action) => executeMetaAction(action),
    onActiveStart: () => {
        continuousGestureGate?.reset();
        cancelPendingAction();
        stopDirectionalScroll();
        stopPointerMove();
        stopRepeat();
    },
    onDisplay: (type, action) => {
        const disp = META_GESTURE_DISPLAY[type];
        if (disp) setGestureText(disp.emoji, metaActionDisplay(action));
    },
    onExecuted: (type, action) => {
        log(msg('logMetaGestureAction', [metaGestureLabel(type), metaActionDisplay(action)]));
    },
});

/* ============================================================
 * マッピング UI
 * ============================================================ */
function buildMappingUI() {
    el.mappingList.innerHTML = '';
    const editMapping = getMappingForMode(operationMode);
    const actionKeys = getActionKeysForMode(operationMode);
    updateOperationModeUI();

    for (const gesture of GESTURABLE_TYPES) {
        const row = document.createElement('div');
        row.className = 'mapping-row';

        const label = document.createElement('span');
        label.className = 'gesture-label';
        label.textContent = `${GESTURE_ICONS[gesture]} ${gestureLabel(gesture)}`;

        const select = document.createElement('select');
        for (const value of actionKeys) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = actionDisplay(value);
            if (editMapping[gesture] === value) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            editMapping[gesture] = select.value;
            saveMapping();
            refreshCurrentMapping();
        });

        row.appendChild(label);
        row.appendChild(select);
        el.mappingList.appendChild(row);
    }
    buildMetaMappingUI();
}

function buildMetaMappingUI() {
    if (!el.metaMappingList) return;
    el.metaMappingList.innerHTML = '';
    const actions = Object.keys(META_ACTION_I18N_KEYS);
    for (const type of META_GESTURE_TYPES) {
        const row = document.createElement('div');
        row.className = 'mapping-row';

        const label = document.createElement('span');
        label.className = 'gesture-label';
        label.textContent = metaGestureLabel(type);

        const select = document.createElement('select');
        const currentValue = actions.includes(metaGestureMapping[type]) ? metaGestureMapping[type] : 'none';
        for (const value of actions) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = metaActionDisplay(value);
            if (currentValue === value) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            metaGestureMapping[type] = select.value;
            chrome.storage.sync.set({ metaGestureMapping });
        });

        row.appendChild(label);
        row.appendChild(select);
        el.metaMappingList.appendChild(row);
    }
}

async function loadMapping() {
    try {
        const result = await chrome.storage.sync.get([
            'gestureMapping', 'mediaGestureMapping', 'browserGestureMapping', 'pointerGestureMapping',
            'operationMode', 'controlEnabled', 'metaGestureMapping', 'toggleGestureType',
        ]);

        const savedMedia = result.mediaGestureMapping || result.gestureMapping;
        if (savedMedia) {
            const saved = { ...savedMedia };
            // 移行: open は通常サインから除外されたため削除
            delete saved.open;
            mediaMapping = { ...DEFAULT_MEDIA_MAPPING, ...saved };
        }

        if (result.browserGestureMapping) {
            const saved = { ...result.browserGestureMapping };
            delete saved.open;
            if (isSameGestureMapping(saved, LEGACY_DEFAULT_BROWSER_MAPPING)) {
                browserMapping = { ...DEFAULT_BROWSER_MAPPING };
                chrome.storage.sync.set({ browserGestureMapping: browserMapping });
            } else {
                browserMapping = { ...DEFAULT_BROWSER_MAPPING, ...saved };
            }
        }

        if (result.pointerGestureMapping) {
            const saved = { ...result.pointerGestureMapping };
            pointerMapping = normalizePointerGestureMapping(saved);
            if (isLegacyDefaultPointerMapping(saved)) {
                chrome.storage.sync.set({ pointerGestureMapping: pointerMapping });
            }
        }

        if (OPERATION_MODE_ORDER.includes(result.operationMode)) {
            operationMode = normalizeOperationMode(result.operationMode);
        }

        if (result.controlEnabled !== undefined) {
            controlEnabled = result.controlEnabled;
            el.chkEnabled.checked = controlEnabled;
        }

        if (result.metaGestureMapping) {
            metaGestureMapping = { ...DEFAULT_META_GESTURE_MAPPING, ...result.metaGestureMapping };
        } else if (result.toggleGestureType) {
            metaGestureMapping = Object.fromEntries(META_GESTURE_TYPES.map(type => [type, 'none']));
            if (META_GESTURE_TYPES.includes(result.toggleGestureType)) {
                metaGestureMapping[result.toggleGestureType] = 'toggleEnabled';
            }
        }

        refreshCurrentMapping();
        updateOperationModeUI();
        pointerVisibilityController?.sync();
    } catch (_) {}
    try {
        const d = DEFAULT_SETTINGS;
        const result = await chrome.storage.sync.get(Object.keys(d));

        applyMirror(result.mirrorCamera ?? d.mirrorCamera);
        applySkeletonOnly(result.skeletonOnly ?? d.skeletonOnly);

        const validWake = ['open', 'open-palm', 'none'];
        wakeGestureType = validWake.includes(result.wakeGestureType) ? result.wakeGestureType : d.wakeGestureType;
        const selWake = $('sel-wake-gesture');
        if (selWake) selWake.value = wakeGestureType;
        setWakeState(WAKE_STATE.IDLE);

        wakeActiveDuration = result.wakeActiveDuration !== undefined
            ? Math.max(1000, Math.min(10000, Number(result.wakeActiveDuration) || d.wakeActiveDuration))
            : d.wakeActiveDuration;
        const rngWake = $('rng-wake-timeout');
        if (rngWake) {
            rngWake.value = wakeActiveDuration / 1000;
            $('wake-timeout-value').textContent = fmtSeconds(wakeActiveDuration);
        }
        updateWakeUI();

        const validToggle = ['frame', 'both-peace', 'peace-fist', 'none'];
        toggleGestureType = validToggle.includes(result.toggleGestureType) ? result.toggleGestureType : d.toggleGestureType;

        gestureHoldTime = result.gestureHoldTime !== undefined
            ? Math.max(0, Math.min(500, Number(result.gestureHoldTime) || 0))
            : d.gestureHoldTime;
        const rngHold = $('rng-hold-time');
        if (rngHold) {
            rngHold.value = gestureHoldTime;
            $('hold-time-value').textContent = fmtSeconds(gestureHoldTime);
        }

        actionRepeatInterval = result.actionRepeatInterval !== undefined
            ? Math.max(200, Math.min(1000, Number(result.actionRepeatInterval) || d.actionRepeatInterval))
            : d.actionRepeatInterval;
        const rngRepeat = $('rng-repeat-interval');
        if (rngRepeat) {
            rngRepeat.value = actionRepeatInterval;
            $('repeat-interval-value').textContent = fmtSeconds(actionRepeatInterval);
        }

        holdScrollSpeed = normalizeMoveSpeed(result.holdScrollSpeed, d.holdScrollSpeed);
        const rngHoldScroll = $('rng-hold-scroll-speed');
        if (rngHoldScroll) {
            rngHoldScroll.value = holdScrollSpeed;
            $('hold-scroll-speed-value').textContent = fmtPercent(holdScrollSpeed);
        }

        pointerMoveSpeed = normalizeMoveSpeed(result.pointerMoveSpeed, d.pointerMoveSpeed);
        const rngPointerMove = $('rng-pointer-move-speed');
        if (rngPointerMove) {
            rngPointerMove.value = pointerMoveSpeed;
            $('pointer-move-speed-value').textContent = fmtPercent(pointerMoveSpeed);
        }

        const fps = result.inferenceFps !== undefined
            ? normalizeInferenceFps(result.inferenceFps, d.inferenceFps)
            : d.inferenceFps;
        inferenceFps = fps;
        idleInferenceFpsEnabled = result.idleInferenceFpsEnabled === true;
        updateTrackerFps();
        const rngFps = $('rng-inference-fps');
        if (rngFps) {
            rngFps.value = fps;
            $('inference-fps-value').textContent = fmtFps(fps);
        }
        if (el.chkIdleInferenceFps) {
            el.chkIdleInferenceFps.checked = idleInferenceFpsEnabled;
        }

        inferenceResolution = normalizeInferenceResolution(result.inferenceResolution, d.inferenceResolution);
        updateTrackerInferenceResolution();
        const selInferenceResolution = $('sel-inference-resolution');
        if (selInferenceResolution) selInferenceResolution.value = inferenceResolution;

        setOkDebugEnabled(result.okDebugEnabled === true, { save: false });

        notifyVolume = result.notifyVolume !== undefined
            ? Math.max(0, Math.min(1, Number(result.notifyVolume)))
            : d.notifyVolume;
        const rngVol = $('rng-notify-volume');
        if (rngVol) {
            rngVol.value = Math.round(notifyVolume * 100);
            $('notify-volume-value').textContent = fmtVolume(notifyVolume);
        }

        uiScale = result.uiScale !== undefined
            ? Math.max(80, Math.min(150, Number(result.uiScale)))
            : d.uiScale;
        document.body.style.zoom = uiScale / 100;
        const rngUi = $('rng-ui-scale');
        if (rngUi) {
            rngUi.value = uiScale;
            $('ui-scale-value').textContent = fmtPercent(uiScale);
        }

        const pipFont = result.pipFontScale !== undefined
            ? Math.max(50, Math.min(200, Number(result.pipFontScale)))
            : d.pipFontScale;
        const rngPip = $('rng-pip-font-scale');
        if (rngPip) {
            rngPip.value = pipFont;
            $('pip-font-scale-value').textContent = fmtPercent(pipFont);
        }

        const ph = result.preferredHand || d.preferredHand;
        tracker.preferredHand = ph;
        const selHand = $('sel-preferred-hand');
        if (selHand) selHand.value = ph;
    } catch (_) {}
    try {
        const result = await chrome.storage.local.get(['selectedCameraId', 'selectedXrealCameraProfile']);
        if (result.selectedCameraId) selectedCameraId = result.selectedCameraId;
        selectedXrealCameraProfile = CameraRuntime.normalizeXrealCameraProfile(result.selectedXrealCameraProfile);
    } catch (_) {}
    // 折りたたみセクションの開閉状態を復元
    try {
        const collapsibleIds = ['section-settings', 'section-gestures', 'section-meta-gestures'];
        const result = await chrome.storage.sync.get(collapsibleIds.map(id => `collapse_${id}`));
        for (const id of collapsibleIds) {
            const val = result[`collapse_${id}`];
            if (val !== undefined) $(id).open = val;
        }
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('settingsActiveTab');
        setSettingsTab(result.settingsActiveTab, { save: false });
    } catch (_) {
        setSettingsTab(settingsActiveTab, { save: false });
    }
}

async function saveMapping() {
    try {
        await chrome.storage.sync.set({
            gestureMapping: mediaMapping,
            mediaGestureMapping: mediaMapping,
            browserGestureMapping: browserMapping,
            pointerGestureMapping: pointerMapping,
        });
    } catch (_) {}
}

/* ============================================================
 * ヘルパー
 * ============================================================ */

/** 骨格のみ表示の適用（UI + tracker 両方を更新） */
function applySkeletonOnly(enabled) {
    tracker.skeletonOnly = enabled;
    tracker._drawDirty = true;
    el.chkSkeleton.checked = enabled;
    el.cameraVideo.style.opacity = enabled ? '0' : '1';
}

function applyMirror(enabled) {
    el.chkMirror.checked = enabled;
    const transform = enabled ? 'scaleX(-1)' : '';
    el.cameraVideo.style.transform = transform;
    el.handCanvas.style.transform = transform;
    // 表示の左右反転 → point-left/right の方向補正に使用
    tracker.displayMirrored = enabled;
}

function normalizeSettingsTab(tabId) {
    return SETTINGS_TAB_IDS.includes(tabId) ? tabId : 'operation';
}

function setSettingsTab(tabId, options = {}) {
    settingsActiveTab = normalizeSettingsTab(tabId);
    document.querySelectorAll('.settings-tab').forEach((tab) => {
        const active = tab.dataset.settingsTab === settingsActiveTab;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.settings-panel').forEach((panel) => {
        const active = panel.id === `settings-panel-${settingsActiveTab}`;
        panel.hidden = false;
        panel.classList.toggle('is-active', active);
        panel.setAttribute('aria-hidden', active ? 'false' : 'true');
        panel.inert = !active;
    });
    if (options.save !== false) {
        chrome.storage.sync.set({ settingsActiveTab }).catch(() => {});
    }
}

function focusSettingsTab(tabId) {
    setSettingsTab(tabId);
    document.querySelector(`.settings-tab[data-settings-tab="${settingsActiveTab}"]`)?.focus();
}

/* ============================================================
 * イベントバインド
 * ============================================================ */
el.linkEyecon.addEventListener('click', openEyecon);

const selCamera = $('sel-camera');
selCamera.addEventListener('change', () => {
    if (selCamera.value === EYECON_VALUE) {
        // EyeCon 誘導選択時はカメラID保存せずボタン切替
        el.btnStartCam.textContent = msg('btnOpenEyecon');
        el.btnStartCam.disabled = false;
    } else {
        selectedCameraId = selCamera.value;
        saveSelectedCamera();
        el.btnStartCam.textContent = msg('btnStartCamera');
    }
    // ユーザーが手動選択したら自動切替追跡をリセット
    prevSelectedBeforeXreal = null;
});

el.btnStartCam.addEventListener('click', startCamera);
el.btnStopCam.addEventListener('click', stopCamera);
$('btn-pip').addEventListener('click', openPipWindow);
$('btn-exit-pip').addEventListener('click', () => {
    if (pipWindowId) {
        chrome.windows.remove(pipWindowId).catch(() => {});
    }
});

el.chkSkeleton.addEventListener('change', () => {
    applySkeletonOnly(el.chkSkeleton.checked);
    chrome.storage.sync.set({ skeletonOnly: el.chkSkeleton.checked });
});

el.chkOkDebug?.addEventListener('change', () => {
    setOkDebugEnabled(el.chkOkDebug.checked);
});

el.chkMirror.addEventListener('change', () => {
    applyMirror(el.chkMirror.checked);
    chrome.storage.sync.set({ mirrorCamera: el.chkMirror.checked });
    // ユーザー操作なので自動復元をキャンセル
    savedMirrorState = null;
});

el.chkEnabled.addEventListener('change', () => {
    setControlEnabled(el.chkEnabled.checked);
});

/** 操作送信の有効/無効を一元的に切り替え */
function setControlEnabled(enabled) {
    controlEnabled = enabled;
    el.chkEnabled.checked = enabled;
    chrome.storage.sync.set({ controlEnabled });
    updateOperationModeUI();
    if (!enabled) {
        stopAllGestureActions();
        setWakeState(WAKE_STATE.IDLE);
    }
    pointerVisibilityController?.sync();
    playBeep(enabled ? 880 : 440, 0.2);
    log(enabled
        ? msg('logOperationEnabledOn', [GestureRuntimeUtils.modeLabel(operationMode)])
        : msg('logOperationEnabledOff', [GestureRuntimeUtils.modeLabel(operationMode)]));
}

document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        setOperationMode(tab.dataset.mode, { beep: false });
    });
});

document.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        setSettingsTab(tab.dataset.settingsTab);
    });
    tab.addEventListener('keydown', (event) => {
        const currentIndex = SETTINGS_TAB_IDS.indexOf(settingsActiveTab);
        let nextIndex = currentIndex;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % SETTINGS_TAB_IDS.length;
        if (event.key === 'ArrowLeft') nextIndex = (currentIndex + SETTINGS_TAB_IDS.length - 1) % SETTINGS_TAB_IDS.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = SETTINGS_TAB_IDS.length - 1;
        if (nextIndex === currentIndex) return;
        event.preventDefault();
        focusSettingsTab(SETTINGS_TAB_IDS[nextIndex]);
    });
});

/** ターゲットタブを現在のアクティブタブに固定 */
async function lockCurrentTab() {
    try {
        // サイドパネルの親ウィンドウを基準にアクティブタブを取得
        const win = await chrome.windows.getCurrent();
        let tabs = await chrome.tabs.query({ active: true, windowId: win.id });
        // サイドパネルの親ウィンドウが通常ウィンドウでない場合（念のため）、通常ウィンドウを探す
        if (!tabs.length || (await chrome.windows.get(tabs[0].windowId)).type !== 'normal') {
            const allTabs = await chrome.tabs.query({ active: true });
            for (const t of allTabs) {
                const w = await chrome.windows.get(t.windowId);
                if (w.type === 'normal') { tabs = [t]; break; }
            }
        }
        if (!tabs.length) return;
        const tab = tabs[0];
        lockedTargetTabId = tab.id;
        clearPageActionStatus();
        const nameEl = $('target-tab-name');
        const title = tab.title || tab.url || String(tab.id);
        nameEl.textContent = title;
        nameEl.title = title;
        nameEl.classList.add('is-locked');
        show($('btn-unlock-tab'));
        hide($('btn-lock-tab'));
        log(msg('logTargetTabLocked', [title]));
    } catch (e) {
        log(msg('logSendError', [e?.message || String(e)]));
    }
}

/** ターゲットタブ固定を解除 */
function unlockTab() {
    lockedTargetTabId = null;
    clearPageActionStatus();
    const nameEl = $('target-tab-name');
    nameEl.textContent = msg('targetTabActive');
    nameEl.title = '';
    nameEl.classList.remove('is-locked');
    show($('btn-lock-tab'));
    hide($('btn-unlock-tab'));
}

const selWakeGesture = $('sel-wake-gesture');
/** ウェイク設定変更時にUI連動（待機時間行の表示・wake-hintテキスト） */
function updateWakeUI() {
    const isNone = wakeGestureType === 'none';
    const rowTimeout = $('row-wake-timeout');
    if (rowTimeout) {
        if (isNone) hide(rowTimeout); else show(rowTimeout);
    }
    const hint = $('wake-hint');
    if (hint) {
        hint.textContent = isNone
            ? msg('hintWakeAlwaysActive')
            : msg('hintWakeWithTimeout', [gestureLabel(wakeGestureType), (wakeActiveDuration / 1000).toFixed(1)]);
    }
}
selWakeGesture.addEventListener('change', () => {
    wakeGestureType = selWakeGesture.value;
    chrome.storage.sync.set({ wakeGestureType });
    setWakeState(WAKE_STATE.IDLE);
    updateWakeUI();
    log(wakeGestureType === 'none' ? msg('logWakeGestureNone') : msg('logWakeGestureChanged', [gestureLabel(wakeGestureType)]));
});

const rngWakeTimeout = $('rng-wake-timeout');
rngWakeTimeout.addEventListener('input', () => {
    wakeActiveDuration = Number(rngWakeTimeout.value) * 1000;
    $('wake-timeout-value').textContent = fmtSeconds(wakeActiveDuration);
    chrome.storage.sync.set({ wakeActiveDuration });
    updateWakeUI();
});

const rngHoldTime = $('rng-hold-time');
rngHoldTime.addEventListener('input', () => {
    gestureHoldTime = Number(rngHoldTime.value);
    $('hold-time-value').textContent = fmtSeconds(gestureHoldTime);
    chrome.storage.sync.set({ gestureHoldTime });
});

const rngHoldScrollSpeed = $('rng-hold-scroll-speed');
rngHoldScrollSpeed.addEventListener('input', () => {
    holdScrollSpeed = normalizeMoveSpeed(rngHoldScrollSpeed.value);
    $('hold-scroll-speed-value').textContent = fmtPercent(holdScrollSpeed);
    chrome.storage.sync.set({ holdScrollSpeed });
});

const rngPointerMoveSpeed = $('rng-pointer-move-speed');
rngPointerMoveSpeed.addEventListener('input', () => {
    pointerMoveSpeed = normalizeMoveSpeed(rngPointerMoveSpeed.value);
    $('pointer-move-speed-value').textContent = fmtPercent(pointerMoveSpeed);
    chrome.storage.sync.set({ pointerMoveSpeed });
});

const rngRepeatInterval = $('rng-repeat-interval');
rngRepeatInterval.addEventListener('input', () => {
    actionRepeatInterval = Number(rngRepeatInterval.value);
    $('repeat-interval-value').textContent = fmtSeconds(actionRepeatInterval);
    chrome.storage.sync.set({ actionRepeatInterval });
});

const rngInferenceFps = $('rng-inference-fps');
rngInferenceFps.addEventListener('input', () => {
    const fps = normalizeInferenceFps(rngInferenceFps.value);
    inferenceFps = fps;
    updateTrackerFps();
    $('inference-fps-value').textContent = fmtFps(fps);
    chrome.storage.sync.set({ inferenceFps: fps });
});

el.chkIdleInferenceFps?.addEventListener('change', () => {
    idleInferenceFpsEnabled = el.chkIdleInferenceFps.checked;
    updateTrackerFps();
    chrome.storage.sync.set({ idleInferenceFpsEnabled });
});

const selInferenceResolution = $('sel-inference-resolution');
selInferenceResolution.addEventListener('change', () => {
    inferenceResolution = normalizeInferenceResolution(selInferenceResolution.value);
    updateTrackerInferenceResolution();
    chrome.storage.sync.set({ inferenceResolution });
    if (cameraStream) {
        scheduleCameraRestartForSettings();
    }
});

const rngNotifyVolume = $('rng-notify-volume');
rngNotifyVolume.addEventListener('input', () => {
    notifyVolume = Number(rngNotifyVolume.value) / 100;
    $('notify-volume-value').textContent = fmtVolume(notifyVolume);
    chrome.storage.sync.set({ notifyVolume });
});

const rngUiScale = $('rng-ui-scale');
// ドラッグ中は数値のみ更新、離した時にzoom適用（レイアウト変動でスライダーが逃げるのを防止）
rngUiScale.addEventListener('input', () => {
    $('ui-scale-value').textContent = fmtPercent(rngUiScale.value);
});
rngUiScale.addEventListener('change', () => {
    uiScale = Number(rngUiScale.value);
    document.body.style.zoom = uiScale / 100;
    chrome.storage.sync.set({ uiScale });
});

const rngPipFontScale = $('rng-pip-font-scale');
rngPipFontScale.addEventListener('input', () => {
    $('pip-font-scale-value').textContent = fmtPercent(rngPipFontScale.value);
});
rngPipFontScale.addEventListener('change', () => {
    chrome.storage.sync.set({ pipFontScale: Number(rngPipFontScale.value) });
});

const selPreferredHand = $('sel-preferred-hand');
selPreferredHand.addEventListener('change', () => {
    tracker.preferredHand = selPreferredHand.value;
    chrome.storage.sync.set({ preferredHand: selPreferredHand.value });
    log(selPreferredHand.value === 'auto'
        ? msg('logPreferredHandAuto')
        : msg('logPreferredHandChanged', [msg(selPreferredHand.value === 'Right' ? 'optionHandRight' : 'optionHandLeft')]));
});

function resetCurrentMapping() {
    if (operationMode === OPERATION_MODES.BROWSER) {
        browserMapping = { ...DEFAULT_BROWSER_MAPPING };
    } else if (operationMode === OPERATION_MODES.POINTER) {
        pointerMapping = { ...DEFAULT_POINTER_MAPPING };
    } else {
        mediaMapping = { ...DEFAULT_MEDIA_MAPPING };
    }
    refreshCurrentMapping();
    saveMapping();
    buildMappingUI();
    log(msg('logMappingReset'));
}

function resetMetaMapping() {
    metaGestureMapping = { ...DEFAULT_META_GESTURE_MAPPING };
    chrome.storage.sync.set({ metaGestureMapping });
    buildMetaMappingUI();
    log(msg('logMetaMappingReset'));
}

function resetSettings() {
    const d = DEFAULT_SETTINGS;
    const {
        operationMode: _defaultOperationMode,
        toggleGestureType: _defaultToggleGestureType,
        ...resetSettings
    } = d;

    // 状態変数を復元
    wakeGestureType = d.wakeGestureType;
    wakeActiveDuration = d.wakeActiveDuration;
    tracker.preferredHand = d.preferredHand;
    gestureHoldTime = d.gestureHoldTime;
    actionRepeatInterval = d.actionRepeatInterval;
    inferenceFps = d.inferenceFps;
    idleInferenceFpsEnabled = d.idleInferenceFpsEnabled;
    inferenceResolution = d.inferenceResolution;
    updateTrackerInferenceResolution();
    setWakeState(WAKE_STATE.IDLE);
    notifyVolume = d.notifyVolume;
    uiScale = d.uiScale;
    holdScrollSpeed = d.holdScrollSpeed;
    pointerMoveSpeed = d.pointerMoveSpeed;
    setOkDebugEnabled(d.okDebugEnabled, { save: false });

    // UIを復元
    $('chk-mirror').checked = d.mirrorCamera; applyMirror(d.mirrorCamera);
    $('chk-skeleton-only').checked = d.skeletonOnly; applySkeletonOnly(d.skeletonOnly);
    if (el.chkOkDebug) el.chkOkDebug.checked = d.okDebugEnabled;
    $('sel-wake-gesture').value = d.wakeGestureType;
    $('rng-wake-timeout').value = d.wakeActiveDuration / 1000;
    $('wake-timeout-value').textContent = fmtSeconds(d.wakeActiveDuration);
    updateWakeUI();
    updateOperationModeUI();
    buildMappingUI();
    $('sel-preferred-hand').value = d.preferredHand;
    $('rng-hold-time').value = d.gestureHoldTime;
    $('hold-time-value').textContent = fmtSeconds(d.gestureHoldTime);
    $('rng-repeat-interval').value = d.actionRepeatInterval;
    $('repeat-interval-value').textContent = fmtSeconds(d.actionRepeatInterval);
    $('rng-hold-scroll-speed').value = d.holdScrollSpeed;
    $('hold-scroll-speed-value').textContent = fmtPercent(d.holdScrollSpeed);
    $('rng-pointer-move-speed').value = d.pointerMoveSpeed;
    $('pointer-move-speed-value').textContent = fmtPercent(d.pointerMoveSpeed);
    $('rng-inference-fps').value = d.inferenceFps;
    $('inference-fps-value').textContent = fmtFps(d.inferenceFps);
    if (el.chkIdleInferenceFps) el.chkIdleInferenceFps.checked = d.idleInferenceFpsEnabled;
    $('sel-inference-resolution').value = d.inferenceResolution;
    $('rng-notify-volume').value = Math.round(d.notifyVolume * 100);
    $('notify-volume-value').textContent = fmtVolume(d.notifyVolume);
    $('rng-ui-scale').value = d.uiScale;
    $('ui-scale-value').textContent = fmtPercent(d.uiScale);
    $('rng-pip-font-scale').value = d.pipFontScale;
    $('pip-font-scale-value').textContent = fmtPercent(d.pipFontScale);
    document.body.style.zoom = d.uiScale / 100;
    pointerVisibilityController?.sync();

    // ストレージに保存
    chrome.storage.sync.set(resetSettings);
    log(msg('logSettingsReset'));
}

const RESET_CONFIRM_CONFIG = {
    mapping: {
        titleKey: 'resetConfirmMappingTitle',
        bodyKey: 'resetConfirmMappingBody',
        action: resetCurrentMapping,
    },
    metaMapping: {
        titleKey: 'resetConfirmMetaMappingTitle',
        bodyKey: 'resetConfirmMetaMappingBody',
        action: resetMetaMapping,
    },
    settings: {
        titleKey: 'resetConfirmSettingsTitle',
        bodyKey: 'resetConfirmSettingsBody',
        action: resetSettings,
    },
};
let pendingResetAction = null;
let resetConfirmReturnFocus = null;

function openResetConfirm(type, returnFocusEl) {
    const config = RESET_CONFIRM_CONFIG[type];
    if (!config) return;
    pendingResetAction = config.action;
    resetConfirmReturnFocus = returnFocusEl || null;
    $('reset-confirm-title').textContent = msg(config.titleKey);
    $('reset-confirm-body').textContent = msg(config.bodyKey);
    const overlay = $('reset-confirm-overlay');
    overlay.classList.remove('is-hidden');
    overlay.setAttribute('aria-hidden', 'false');
    $('reset-confirm-apply').focus();
}

function closeResetConfirm() {
    pendingResetAction = null;
    const overlay = $('reset-confirm-overlay');
    overlay.classList.add('is-hidden');
    overlay.setAttribute('aria-hidden', 'true');
    resetConfirmReturnFocus?.focus();
    resetConfirmReturnFocus = null;
}

function bindResetConfirmButton(id, type) {
    $(id)?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openResetConfirm(type, event.currentTarget);
    });
}

bindResetConfirmButton('btn-reset-mapping', 'mapping');
bindResetConfirmButton('btn-reset-meta-mapping', 'metaMapping');
bindResetConfirmButton('btn-reset-settings', 'settings');

$('reset-confirm-cancel').addEventListener('click', closeResetConfirm);
document.querySelector('#reset-confirm-overlay .reset-confirm-backdrop').addEventListener('click', closeResetConfirm);
$('reset-confirm-apply').addEventListener('click', () => {
    const action = pendingResetAction;
    closeResetConfirm();
    action?.();
});
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('reset-confirm-overlay').classList.contains('is-hidden')) {
        closeResetConfirm();
    }
});

/* ターゲットタブ固定 */
$('btn-lock-tab').addEventListener('click', lockCurrentTab);
$('btn-unlock-tab').addEventListener('click', unlockTab);

chrome.tabs.onRemoved.addListener((tabId) => {
    if (lockedTargetTabId === tabId) {
        unlockTab();
        log(msg('logTargetTabClosed'));
    }
});

chrome.tabs.onActivated.addListener(() => {
    if (!lockedTargetTabId) clearPageActionStatus();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (lockedTargetTabId === tabId && changeInfo.title !== undefined) {
        $('target-tab-name').textContent = tab.title || String(tab.id);
        $('target-tab-name').title = tab.title || String(tab.id);
    }
    if (pageActionStatusVisible && changeInfo.status === 'complete' && (!lockedTargetTabId || lockedTargetTabId === tabId)) {
        clearPageActionStatus();
    }
});

el.btnClearLog.addEventListener('click', () => {
    el.log.textContent = '';
    const manifest = chrome.runtime.getManifest();
    log(msg('logAppStartup', [manifest.version]));
});

$('btn-copy-log').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(el.log.textContent);
        log(msg('logCopySuccess'));
    } catch (e) {
        log(msg('logCopyFailed', [e.message]));
    }
});

el.btnCopyDebugScreenshot?.addEventListener('click', async () => {
    const prevText = el.btnCopyDebugScreenshot.textContent;
    el.btnCopyDebugScreenshot.disabled = true;
    el.btnCopyDebugScreenshot.textContent = msg('btnCopyDebugScreenshotBusy');
    try {
        await copyDebugScreenshotToClipboard();
        log(msg('logDebugScreenshotCopySuccess'));
    } catch (e) {
        log(msg('logDebugScreenshotCopyFailed', [e.message]));
    } finally {
        el.btnCopyDebugScreenshot.disabled = false;
        el.btnCopyDebugScreenshot.textContent = prevText;
    }
});

// 折りたたみセクションの開閉状態を永続化
for (const id of ['section-settings', 'section-gestures', 'section-meta-gestures']) {
    const det = $(id);
    if (det) {
        det.addEventListener('toggle', () => {
            chrome.storage.sync.set({ [`collapse_${id}`]: det.open });
        });
    }
}

/* ============================================================
 * チュートリアル（初回起動時のガイド + 再表示ボタン）
 * ============================================================
 * モーダル + スポットライト方式。対象要素を clip-path で切り抜いて操作可能に保ち、
 * Next/Back/Skip + 主要アクション検出（カメラ開始・ウェイク発火）で自動進行。
 */
// targets は配列で複数要素を同時にハイライト可能（外接矩形で1つの切抜きにまとめる）
const TUTORIAL_STEPS = [
    { id: 'welcome', targets: [],                                       titleKey: 'tutorialStep1Title', bodyKey: 'tutorialStep1Body' },
    { id: 'camera',  targets: ['#camera-controls'],                     titleKey: 'tutorialStep2Title', bodyKey: 'tutorialStep2Body', autoAdvanceOn: 'camera-started' },
    { id: 'mode',    targets: ['#operation-mode-section', '#operation-mode-label'], titleKey: 'tutorialStep3Title', bodyKey: 'tutorialStep3Body' },
    { id: 'wake',    targets: ['#camera-section', '#gesture-section'],  titleKey: 'tutorialStep4Title', bodyKey: 'tutorialStep4Body', autoAdvanceOn: 'wake-activated' },
    { id: 'command', targets: ['#section-gestures', '#mapping-list'],   titleKey: 'tutorialStep5Title', bodyKey: 'tutorialStep5Body' },
    // #chk-enabled は opacity:0 で 0x0。視認できる親ラベル + 「操作モード」テキストを外接矩形化する
    { id: 'toggle',  targets: ['.header-label', 'label.toggle-switch:has(#chk-enabled)', '#section-meta-gestures'], titleKey: 'tutorialStep6Title', bodyKey: 'tutorialStep6Body', bodyNoToggleKey: 'tutorialStep6BodyNoToggle' },
    { id: 'pip',     targets: ['#btn-pip'],                             titleKey: 'tutorialStep7Title', bodyKey: 'tutorialStep7Body' },
];
let tutorialIndex = 0;
let tutorialActive = false;
let tutorialHighlightEls = [];

function tutorialCurrentStep() { return TUTORIAL_STEPS[tutorialIndex]; }

function startTutorial() {
    tutorialIndex = 0;
    tutorialActive = true;
    // チュートリアル中は操作送信を自動でON（OFFだとウェイクが発火せずステップ進行が止まる）
    if (!controlEnabled) setControlEnabled(true);
    const overlay = $('tutorial-overlay');
    show(overlay);
    overlay.setAttribute('aria-hidden', 'false');
    renderTutorialStep();
}

function endTutorial(markCompleted) {
    tutorialActive = false;
    const overlay = $('tutorial-overlay');
    hide(overlay);
    overlay.setAttribute('aria-hidden', 'true');
    clearTutorialHighlight();
    if (markCompleted) chrome.storage.sync.set({ tutorialCompleted: true });
}

function advanceTutorial() {
    if (!tutorialActive) return;
    if (tutorialIndex < TUTORIAL_STEPS.length - 1) {
        tutorialIndex++;
        renderTutorialStep();
    } else {
        endTutorial(true);
    }
}

function retreatTutorial() {
    if (!tutorialActive || tutorialIndex === 0) return;
    tutorialIndex--;
    renderTutorialStep();
}

function clearTutorialHighlight() {
    for (const el of tutorialHighlightEls) el.classList.remove('tutorial-highlight');
    tutorialHighlightEls = [];
}

function renderTutorialStep() {
    const step = tutorialCurrentStep();
    const total = TUTORIAL_STEPS.length;
    if (step.id === 'command') $('section-gestures').open = true;
    if (step.id === 'toggle') $('section-meta-gestures').open = true;
    $('tutorial-indicator').textContent = msg('tutorialStepIndicator', [String(tutorialIndex + 1), String(total)]);
    $('tutorial-title').textContent = msg(step.titleKey);
    let bodyText;
    if (step.id === 'toggle') {
        const toggleEntry = Object.entries(metaGestureMapping)
            .find(([, action]) => action && action !== 'none');
        if (!toggleEntry) {
            bodyText = msg(step.bodyNoToggleKey);
        } else {
            bodyText = msg(step.bodyKey, [
                metaGestureLabel(toggleEntry[0]),
                metaActionDisplay(toggleEntry[1]),
            ]);
        }
    } else {
        bodyText = msg(step.bodyKey);
    }
    $('tutorial-body').textContent = bodyText;

    const btnNext = $('tutorial-next');
    btnNext.textContent = (tutorialIndex === total - 1) ? msg('tutorialBtnFinish') : msg('tutorialBtnNext');
    $('tutorial-back').style.visibility = (tutorialIndex === 0) ? 'hidden' : 'visible';

    clearTutorialHighlight();
    // 非表示要素（is-hidden 等）はハイライト対象外。存在する要素だけ集める。
    const els = (step.targets || [])
        .map(sel => document.querySelector(sel))
        .filter(el => el && el.offsetParent !== null);
    tutorialHighlightEls = els;
    for (const el of els) el.classList.add('tutorial-highlight');
    if (els.length) els[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    // レイアウト確定後に配置（scrollIntoView 直後の rect がズレるため次フレームで再配置）
    requestAnimationFrame(positionTutorialElements);
}

/** 複数要素の外接矩形を返す。要素が無ければ null。 */
function unionRect(elements) {
    if (!elements.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of elements) {
        const r = el.getBoundingClientRect();
        if (r.left < left) left = r.left;
        if (r.top < top) top = r.top;
        if (r.right > right) right = r.right;
        if (r.bottom > bottom) bottom = r.bottom;
    }
    return { left, top, right, bottom };
}

function positionTutorialElements() {
    if (!tutorialActive) return;
    const mask = document.querySelector('#tutorial-overlay .tutorial-mask');
    const card = document.querySelector('#tutorial-overlay .tutorial-card');
    if (!mask || !card) return;

    // body の zoom (表示サイズ設定) を補正。getBoundingClientRect はズーム後座標、
    // clip-path / card.top は要素ローカル座標なので、ズームで割ってローカル空間に変換する。
    const zoom = parseFloat(document.body.style.zoom) || 1;
    const vh = window.innerHeight / zoom;
    const vw = window.innerWidth / zoom;
    const rect = unionRect(tutorialHighlightEls);

    if (rect) {
        const pad = 4;
        const x1 = Math.max(0, rect.left / zoom - pad);
        const y1 = Math.max(0, rect.top / zoom - pad);
        const x2 = Math.min(vw, rect.right / zoom + pad);
        const y2 = Math.min(vh, rect.bottom / zoom + pad);
        mask.style.clipPath = `polygon(0 0, 0 100%, ${x1}px 100%, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px 100%, 100% 100%, 100% 0)`;
        const cardHeight = card.offsetHeight || 180;
        const belowSpace = vh - y2;
        card.style.top = (belowSpace >= cardHeight + 16)
            ? `${y2 + 8}px`
            : `${Math.max(8, y1 - cardHeight - 8)}px`;
    } else {
        mask.style.clipPath = 'none';
        const cardHeight = card.offsetHeight || 180;
        card.style.top = `${Math.max(16, (vh - cardHeight) / 2)}px`;
    }
}

window.addEventListener('resize', positionTutorialElements);
window.addEventListener('scroll', positionTutorialElements, true);

$('tutorial-next').addEventListener('click', advanceTutorial);
$('tutorial-back').addEventListener('click', retreatTutorial);
$('tutorial-skip').addEventListener('click', () => endTutorial(true));
$('btn-show-tutorial').addEventListener('click', () => startTutorial());

/* ============================================================
 * 初期化
 * ============================================================ */
async function init() {
    applyI18n();
    const manifest = chrome.runtime.getManifest();
    log(msg('logAppStartup', [manifest.version]));

    await loadMapping();
    buildMappingUI();

    // セットアップページ経由の許可がサイドパネル再読込前に完了していた場合
    const stored = await chrome.storage.local.get('cameraPermissionReady');
    if (stored.cameraPermissionReady) {
        log(msg('logCameraPermissionReceived'));
        chrome.storage.local.remove('cameraPermissionReady');
    }

    // カメラポーリング + devicechange リスナー
    navigator.mediaDevices.addEventListener('devicechange', checkCamera);
    startCameraPolling();

    // PiP 状態復元（サイドパネルが再読込された場合）
    try {
        const { pipState } = await chrome.storage.session.get('pipState');
        if (pipState?.windowId) {
            // ウィンドウがまだ存在するか確認
            const win = await chrome.windows.get(pipState.windowId).catch(() => null);
            if (win) {
                pipWindowId = pipState.windowId;
                pipTargetTabId = pipState.targetTabId || null;
                show($('pip-active-section'));
                hide(el.btnStartCam);

                // ウィンドウ閉鎖を監視
                const capturedId = pipWindowId;
                const onRemoved = (windowId) => {
                    if (windowId === capturedId) {
                        chrome.windows.onRemoved.removeListener(onRemoved);
                        pipWindowId = null;
                        pipTargetTabId = null;
                        chrome.storage.session.remove('pipState');
                        hide($('pip-active-section'));
                        show(el.cameraControls);
                        show(el.btnStartCam);
                        el.btnStartCam.disabled = false;
                        el.btnStartCam.textContent = msg('btnStartCamera');
                        log(msg('logPipExit'));
                    }
                };
                chrome.windows.onRemoved.addListener(onRemoved);
            } else {
                // ウィンドウが既に閉じている場合はクリーンアップ
                chrome.storage.session.remove('pipState');
            }
        }
    } catch (_) {}

    // ポップアップからの復帰時: カメラ自動再開
    try {
        const { pipReturnToSidepanel } = await chrome.storage.session.get('pipReturnToSidepanel');
        if (pipReturnToSidepanel) {
            chrome.storage.session.remove('pipReturnToSidepanel');
            // カメラ ID を復元して自動開始
            if (pipReturnToSidepanel.cameraId) {
                selectedCameraId = pipReturnToSidepanel.cameraId;
            }
            selectedXrealCameraProfile = CameraRuntime.normalizeXrealCameraProfile(
                pipReturnToSidepanel.xrealCameraProfile
            ) || selectedXrealCameraProfile;
            log(msg('logPipReturned'));
            startCamera();
        }
    } catch (_) {}

    // 初回起動: チュートリアル未完了ならガイドを表示
    // PiP 復帰時など他ワークフロー進行中は出さない
    // 既存ユーザー（カメラ選択済み）にはチュートリアル済みとして印を付けて出さない
    try {
        const { tutorialCompleted } = await chrome.storage.sync.get('tutorialCompleted');
        const isPipActive = !!pipWindowId;
        if (!tutorialCompleted && !isPipActive) {
            const { selectedCameraId: storedCam } = await chrome.storage.local.get('selectedCameraId');
            if (storedCam) {
                chrome.storage.sync.set({ tutorialCompleted: true });
            } else {
                startTutorial();
            }
        }
    } catch (_) {}
}

function cleanupForPageExit() {
    cameraRestartController.cancel();
    stopAllGestureActions();
    pointerVisibilityController?.stop({ hide: true });
    tracker.stop();
    cameraStream = CameraRuntime.releaseCameraStream(cameraStream, el.cameraVideo);
    if (!takenOver) {
        chrome.runtime.sendMessage({ type: 'release-active-instance', instanceId }).catch(() => {});
    }
}

window.addEventListener('pagehide', cleanupForPageExit);
window.addEventListener('beforeunload', cleanupForPageExit);

init();
