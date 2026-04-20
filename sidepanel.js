/**
 * Side Panel — カメラ + ハンドトラッキング + メディアコントロール
 *
 * ブラウザに接続された全カメラに対応。カメラドロップダウンで選択可能。
 * 電気メガネカメラが検出された場合は自動で優先選択される。
 * MediaPipe でハンドサインを認識し、content-script 経由でメディア操作を行う。
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

/** i18n ヘルパー — chrome.i18n.getMessage のショートカット */
function msg(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
}

/** data-i18n / data-i18n-title 属性を走査して翻訳を適用 */
function applyI18n() {
    for (const el of document.querySelectorAll('[data-i18n]')) {
        const text = msg(el.dataset.i18n);
        if (text) el.textContent = text;
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
        const text = msg(el.dataset.i18nTitle);
        if (text) el.title = text;
    }
}

/** スライダー値の i18n フォーマットヘルパー */
function fmtSeconds(ms) {
    return ms === 0 ? msg('formatImmediate') : msg('formatSeconds', [(ms / 1000).toFixed(1)]);
}
function fmtFps(fps) { return msg('formatFps', [String(fps)]); }
function fmtPercent(n) { return msg('formatPercent', [String(n)]); }
function fmtVolume(v) { return v <= 0 ? msg('formatVolumeOff') : fmtPercent(Math.round(v * 100)); }

const GESTURE_ICONS = {
    fist: '✊', ok: '👌', aloha: '🤙', 'point-left': '👈', 'point-right': '👉', peace: '✌️',
    thumbsup: '👍', thumbsdown: '👎', open: '🖐️',
    unknown: '❓',
};

/* ハンドサイン表示名 — i18n メッセージから取得 */
const GESTURE_I18N_KEYS = {
    fist: 'gestureFist', peace: 'gesturePeace', ok: 'gestureOk', aloha: 'gestureAloha',
    'point-right': 'gesturePointRight', 'point-left': 'gesturePointLeft',
    thumbsup: 'gestureThumbsup', thumbsdown: 'gestureThumbsdown',
    open: 'gestureOpen', unknown: 'gestureUnknown',
};
function gestureLabel(key) {
    return msg(GESTURE_I18N_KEYS[key] ?? 'gestureUnknown');
}

/** アクション表示名 — i18n キーへのマッピング */
const ACTION_I18N_KEYS = {
    playPause: 'actionPlayPause', play: 'actionPlay', pause: 'actionPause',
    volumeUp: 'actionVolumeUp', volumeDown: 'actionVolumeDown', mute: 'actionMute',
    nextTrack: 'actionNextTrack', prevTrack: 'actionPrevTrack',
    seekForward: 'actionSeekForward', seekBackward: 'actionSeekBackward',
    none: 'actionNone',
};
function actionLabel(key) {
    return msg(ACTION_I18N_KEYS[key] ?? 'actionNone');
}

const REPEATABLE_ACTIONS = new Set(['volumeUp', 'volumeDown', 'seekForward', 'seekBackward']);

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

const GESTURABLE_TYPES = [
    'fist', 'peace', 'ok', 'aloha', 'point-right', 'point-left',
    'thumbsup', 'thumbsdown',
];

const CAMERA_POLL_INTERVAL = 3000;

/* ============================================================
 * 状態
 * ============================================================ */
const tracker = new HandTracker();
let currentMapping = { ...DEFAULT_MAPPING };
let controlEnabled = true;
let cameraStream = null;
let lastActionTime = 0;
const ACTION_COOLDOWN = 800;
let cameraPollId = null;
let selectedCameraId = null;    // UI で選択中のカメラ
let activeCameraId = null;      // 実際に動作中のカメラ
let availableCameras = [];      // 検出済みカメラリスト
let cameraCheckSeq = 0;         // checkCamera 排他制御用
let prevSelectedBeforeXreal = null;  // 電気メガネカメラ自動切替前の選択
let hadXrealCamera = false;          // 前回ポーリング時に電気メガネカメラがあったか

// --- ウェイクサイン状態マシン ---
// IDLE: サイン表示のみ、アクション発火しない
// ACTIVE: open 検出後、コマンドサインでアクション発火可能
const WAKE_STATE = { IDLE: 'idle', ACTIVE: 'active' };
let wakeState = WAKE_STATE.IDLE;
let wakeTimeout = null;
const WAKE_ACTIVE_DURATION = 5000;   // ACTIVE 持続時間デフォルト (ms)
let wakeActiveDuration = WAKE_ACTIVE_DURATION;
// ウェイクサイン種別: 'open' | 'none'
let wakeGestureType = 'open';
// サイン確定待機: 同じサインが holdTime 以上持続して初めてアクション発火
let gestureHoldTime = 300;          // デフォルト 0.3秒
let pendingActionTimer = null;
let pendingGesture = null;
// リピート: 継続的なアクション（音量・シーク）のインターバル
let actionRepeatInterval = 1000;    // デフォルト 1.0秒
let repeatTimer = null;
let repeatingGesture = null;
let notifyVolume = 0.3;             // 通知音量 (0.0〜1.0)
let uiScale = 100;                  // 表示サイズ (80〜150%)

// --- メタサイン（操作トグル）---
let toggleGestureType = 'frame';    // 'frame' | 'both-peace' | 'peace-fist' | 'none'
let metaGestureActive = false;
let metaGestureStartTime = 0;
// メガネカメラ使用時のミラー自動OFF用
let savedMirrorState = null;       // null=自動変更なし, boolean=変更前の値
let metaGestureLastSeen = 0;
let lastToggleTime = 0;
const META_COOLDOWN_MS = 2000;      // トグル後のクールダウン
const META_GRACE_MS = 150;          // 一時的未検出の許容時間

// --- PiP (Picture-in-Picture) ---
let pipWindowId = null;             // PiP ポップアップウィンドウの ID
let pipTargetTabId = null;          // PiP 開始時のアクティブタブ ID

// --- 単一インスタンス制御 ---
const instanceId = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let takenOver = false;              // 別のインスタンスに所有権を奪われた

/* ============================================================
 * DOM
 * ============================================================ */
const $ = (id) => document.getElementById(id);
/** CSS で display:none が設定された要素の表示切替ヘルパー */
const show = (elem) => { elem.style.display = ''; elem.classList.remove('is-hidden'); };
const hide = (elem) => { elem.classList.add('is-hidden'); };
/** EyeCon 誘導用の特殊カメラ選択値 */
const EYECON_VALUE = '__eyecon__';

const el = {
    setupHint:       $('setup-hint'),
    linkEyecon:      $('link-eyecon'),

    cameraControls:  $('camera-controls'),
    cameraSection:   $('camera-section'),
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

    mappingList:     $('mapping-list'),
    chkEnabled:      $('chk-enabled'),
    btnReset:        $('btn-reset-mapping'),

    log:             $('log'),
    btnClearLog:     $('btn-clear-log'),
};

/* ============================================================
 * ログ
 * ============================================================ */
function log(text) {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    el.log.textContent += `[${ts}] ${text}\n`;
    el.log.scrollTop = el.log.scrollHeight;
    console.log(`[GW] ${text}`);
}

/* ============================================================
 * カメラ検出 — 全カメラ対応、電気メガネ自動優先選択
 * ============================================================
 * chrome-extension:// では enumerateDevices() のラベルが空。
 * カメラ権限を取得済みならラベルが見えるのでポーリング + devicechange で検出、
 * 未取得なら「カメラ開始」ボタンで getUserMedia → 権限取得 → 検出。
 */

/** 電気メガネのカメラかどうかを判定 */
function isXrealCamera(device) {
    return /XREAL|3318|Nreal|0486|0817|0909/.test(device.label);
}

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

        const videoCams = devices.filter(d => d.kind === 'videoinput');

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

        availableCameras = videoCams;
        populateCameraSelect(videoCams);

        const hasXreal = videoCams.some(d => isXrealCamera(d));
        const xrealJustConnected = hasXreal && !hadXrealCamera;
        const xrealJustDisconnected = !hasXreal && hadXrealCamera;
        hadXrealCamera = hasXreal;

        // 電気メガネカメラが新しく接続 → カメラ未稼働なら自動選択
        if (xrealJustConnected && !activeCameraId) {
            const xreal = videoCams.find(d => isXrealCamera(d));
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
            const xreal = videoCams.find(d => isXrealCamera(d));
            selectedCameraId = xreal ? xreal.deviceId : videoCams[0].deviceId;
            $('sel-camera').value = selectedCameraId;
            saveSelectedCamera();
        }

        updateCameraStatus('ready');
    } catch (_) {}
}

/** カメラドロップダウンを更新（差分がある場合のみ再構築） */
function populateCameraSelect(cameras) {
    const sel = $('sel-camera');
    const hasXreal = cameras.some(c => isXrealCamera(c));
    // 電気メガネ未検出時は EyeCon 誘導を含めた ID で差分比較
    const newIds = cameras.map(c => c.deviceId).join(',') + (hasXreal ? '' : ',__eyecon__');
    if (sel.dataset.cameraIds === newIds) return;
    sel.dataset.cameraIds = newIds;

    sel.innerHTML = '';
    for (const cam of cameras) {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        const prefix = isXrealCamera(cam) ? '🕶️ ' : '📷 ';
        const label = isXrealCamera(cam)
            ? msg('xrealCameraLabel')
            : (cam.label || msg('cameraFallbackName', [String(cameras.indexOf(cam) + 1)]));
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
    try { chrome.storage.local.set({ selectedCameraId }); } catch (_) {}
}

/* ============================================================
 * カメラ制御
 * ============================================================ */
async function startCamera() {
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

        // getUserMedia — 選択カメラ or 任意カメラ（権限取得用）
        const constraints = {
            video: selectedCameraId
                ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
                : { width: { ideal: 1280 }, height: { ideal: 720 } }
        };
        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);

        const track = cameraStream.getVideoTracks()[0];
        activeCameraId = track.getSettings().deviceId;
        log(msg('logCameraAcquired', [track?.label || 'Camera']));

        // メガネカメラの場合、ミラーを一時的にOFF
        if (isXrealCamera(track)) {
            savedMirrorState = el.chkMirror.checked;
            if (savedMirrorState) {
                el.chkMirror.checked = false;
                applyMirror(false);
                log(msg('logXrealMirrorAuto'));
            }
        }

        // 権限取得直後（selectedCameraId 未設定）: カメラリストを構築して選択反映
        if (!selectedCameraId) {
            await checkCamera();
            selectedCameraId = activeCameraId;
            const sel = $('sel-camera');
            if (sel) sel.value = selectedCameraId;
            saveSelectedCamera();
        }

        // トラック終了監視 — USB抜けなどで自動停止
        track.addEventListener('ended', () => {
            log(msg('logCameraDisconnected'));
            stopCamera();
        });

        el.cameraVideo.srcObject = cameraStream;
        await new Promise(r => { el.cameraVideo.onloadeddata = r; });

        applySkeletonOnly(el.chkSkeleton.checked);
        await tracker.start(el.cameraVideo, el.handCanvas, {
            skeletonOnly: el.chkSkeleton.checked,
        });

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
        log(msg('logCameraStarted'));
    } catch (e) {
        const errMsg = e?.message || e?.name || String(e);
        if (e?.name === 'NotAllowedError') {
            showCameraPermissionHint();
        } else if (e?.name === 'OverconstrainedError') {
            log(msg('logCameraConstraintError'));
            selectedCameraId = null;
            startCameraPolling();
        } else {
            log(msg('logCameraError', [errMsg]));
        }
        console.error('[GW] Camera error:', e);
        activeCameraId = null;
        el.btnStartCam.disabled = false;
        el.btnStartCam.textContent = msg('btnStartCamera');
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
        chrome.tabs.create({ url: chrome.runtime.getURL('camera-setup.html') });
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
    // PiP ポップアップが開いている場合は閉じる
    if (pipWindowId) {
        chrome.windows.remove(pipWindowId).catch(() => {});
        pipWindowId = null;
        pipTargetTabId = null;
        chrome.storage.session.remove('pipState');
    }
    tracker.stop();
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    el.cameraVideo.srcObject = null;
    show(el.btnStartCam);
    el.btnStartCam.disabled = false;
    el.btnStartCam.textContent = msg('btnStartCamera');
    hide(el.btnStopCam);
    hide($('btn-pip'));
    hide(el.cameraSection);
    // メタサイン状態もリセット
    metaGestureActive = false;    metaGestureStartTime = 0;
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
 * 独立したポップアップウィンドウ (pip.html) でカメラ＋ハンドトラッキングを
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

        // サイドパネルの認識インスタンス所有権を先に解放
        // （ポップアップが claim した時にテイクオーバーが発生しないようにする）
        await chrome.runtime.sendMessage({
            type: 'release-active-instance',
            instanceId,
        }).catch(() => {});

        tracker.stop();
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
            cameraStream = null;
        }
        el.cameraVideo.srcObject = null;
        activeCameraId = null;
        hide(el.cameraSection);
        hide($('btn-pip'));
        hide(el.btnStopCam);

        // ポップアップウィンドウを画面右上に作成
        const params = new URLSearchParams({
            camera: cameraId || '',
            targetTab: String(pipTargetTabId || ''),
            windowId: String(browserWindowId),
        });
        const popupWidth = 400;
        const popupHeight = 320;
        const screenW = currentWindow.width || screen.availWidth;
        const screenLeft = currentWindow.left || 0;
        const screenTop = currentWindow.top || 0;
        const pip = await chrome.windows.create({
            type: 'popup',
            url: `pip.html?${params}`,
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
            pipState: { windowId: pipWindowId, targetTabId: pipTargetTabId, cameraId, browserWindowId },
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
        // カメラを停止（PiP ポップアップも含む）
        if (pipWindowId) {
            chrome.windows.remove(pipWindowId).catch(() => {});
            pipWindowId = null;
            pipTargetTabId = null;
            chrome.storage.session.remove('pipState');
        }
        tracker.stop();
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
            cameraStream = null;
        }
        el.cameraVideo.srcObject = null;
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
function setGestureText(emoji, name) {
    el.gestureEmoji.textContent = emoji;
    el.gestureName.textContent = name;
}


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
            break;
    }
}

/** リピート中にアクティブ待機時間をリセット延長 */
function extendWakeTimeout() {
    if (wakeGestureType === 'none') return;
    if (wakeTimeout) { clearTimeout(wakeTimeout); wakeTimeout = null; }
    wakeTimeout = setTimeout(() => {
        setWakeState(WAKE_STATE.IDLE);
        log(msg('logWakeTimeout'));
    }, wakeActiveDuration);
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

/** holdTime 経過後にアクションを確定発火する */
function confirmAction(gesture, action) {
    const now = Date.now();
    if (now - lastActionTime < ACTION_COOLDOWN) return;
    lastActionTime = now;

    log(msg('logGestureAction', [gestureLabel(gesture), actionLabel(action)]));
    sendAction(action);

    // リピート対応アクション → インターバル開始（ウェイク IDLE にしない）
    if (REPEATABLE_ACTIONS.has(action) && actionRepeatInterval > 0) {
        repeatingGesture = gesture;
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
    const wasRepeating = repeatingGesture !== null;
    stopRepeat();
    if (wasRepeating && wakeGestureType !== 'none') {
        setWakeState(WAKE_STATE.IDLE);
    }
}

tracker.addEventListener('gesture', (e) => {
    const gesture = e.detail.gesture;
    if (!gesture) {
        setGestureText('—', '');
        stopAllGestureActions();
        // メタサイン状態もリセット（手が消えた）
        metaGestureActive = false;
        metaGestureStartTime = 0;
        return;
    }

    setGestureText(GESTURE_ICONS[gesture] || '❓', gestureLabel(gesture));

    // メタサイン検出中は通常アクションを抑制
    if (metaGestureActive) return;

    if (!controlEnabled) return;

    // open ウェイクモード: open で ACTIVE に遷移
    if (wakeGestureType === 'open' && gesture === 'open') {
        stopAllGestureActions();
        if (wakeState === WAKE_STATE.IDLE) {
            setWakeState(WAKE_STATE.ACTIVE);
            log(msg('logWakeActivated'));
        }
        return;
    }

    // ウェイクモード有効時: ACTIVE でなければ発火しない
    if (wakeGestureType !== 'none' && wakeState !== WAKE_STATE.ACTIVE) return;

    const action = currentMapping[gesture];
    if (!action || action === 'none') { stopAllGestureActions(); return; }

    // リピート中 or 確定待機中の同じサイン → 継続
    if (gesture === repeatingGesture || gesture === pendingGesture) return;

    // 新しいサイン → すべてリセットして確定タイマー開始
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

/** 2D 距離（正規化座標） */
function dist2d(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** フレームサイン: 両手の親指先端⇔人差し指先端が交差接近 */
function detectFrameGesture(hands) {
    for (let i = 0; i < hands.length; i++) {
        for (let j = i + 1; j < hands.length; j++) {
            const lm1 = hands[i].landmarks;
            const lm2 = hands[j].landmarks;

            // パームサイズ基準のスケール相対閾値
            const ps1 = dist2d(lm1[0], lm1[9]);
            const ps2 = dist2d(lm2[0], lm2[9]);
            const avgPs = (ps1 + ps2) / 2;
            const threshold = avgPs * 0.5;

            // 親指先端(4)⇔人差し指先端(8) が交差で接近
            const d1 = dist2d(lm1[4], lm2[8]);
            const d2 = dist2d(lm1[8], lm2[4]);

            if (d1 < threshold && d2 < threshold) {
                // 接触点が縦に分離している（四角の形状確認）
                const cy1 = (lm1[4].y + lm2[8].y) / 2;
                const cy2 = (lm1[8].y + lm2[4].y) / 2;
                if (Math.abs(cy1 - cy2) > avgPs * 0.3) return true;
            }
        }
    }
    return false;
}

/** メタサイン検出（両手の組み合わせ） */
function detectMetaGesture(hands) {
    if (toggleGestureType === 'none' || hands.length < 2) return false;

    switch (toggleGestureType) {
        case 'frame':
            return detectFrameGesture(hands);
        case 'both-peace':
            return hands.filter(h => h.gesture === 'peace').length >= 2;
        case 'peace-fist':
            return hands.some(h => h.gesture === 'peace') &&
                   hands.some(h => h.gesture === 'fist');
        default:
            return false;
    }
}

const META_GESTURE_DISPLAY = {
    frame: { emoji: '🖼️', i18nKey: 'metaGestureFrame' },
    'both-peace': { emoji: '✌️✌️', i18nKey: 'metaGestureBothPeace' },
    'peace-fist': { emoji: '✌️✊', i18nKey: 'metaGesturePeaceFist' },
};

/** frame イベント: メタサインの検出とトグル */
tracker.addEventListener('frame', (e) => {
    const { gestures: hands } = e.detail;
    const now = Date.now();

    // クールダウン中はスキップ
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
            // 通常アクションの保留をキャンセル
            cancelPendingAction();
            stopRepeat();
        }
        metaGestureLastSeen = now;

        // メタサインを表示に反映
        const disp = META_GESTURE_DISPLAY[toggleGestureType];
        if (disp) {
            setGestureText(disp.emoji, msg(disp.i18nKey));
        }

        // 判定待機時間経過 → トグル
        const holdMs = Math.max(gestureHoldTime, 200);
        if (now - metaGestureStartTime >= holdMs) {
            setControlEnabled(!controlEnabled);
            lastToggleTime = now;
            metaGestureActive = false;
            metaGestureStartTime = 0;
        }
    } else if (metaGestureActive) {
        // 猶予期間内なら保持（raw サインの一時的な未検出を許容）
        if (now - metaGestureLastSeen > META_GRACE_MS) {
            metaGestureActive = false;
            metaGestureStartTime = 0;
        }
    }
});

async function sendAction(action) {
    try {
        await chrome.runtime.sendMessage({ type: 'gesture-action', action });
    } catch (e) {
        log(msg('logSendError', [e?.message || String(e)]));
    }
}

/* ============================================================
 * マッピング UI
 * ============================================================ */
function buildMappingUI() {
    el.mappingList.innerHTML = '';
    for (const gesture of GESTURABLE_TYPES) {
        const row = document.createElement('div');
        row.className = 'mapping-row';

        const label = document.createElement('span');
        label.className = 'gesture-label';
        label.textContent = `${GESTURE_ICONS[gesture]} ${gestureLabel(gesture)}`;

        const select = document.createElement('select');
        for (const [value] of Object.entries(ACTION_I18N_KEYS)) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = actionLabel(value);
            if (currentMapping[gesture] === value) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            currentMapping[gesture] = select.value;
            saveMapping();
        });

        row.appendChild(label);
        row.appendChild(select);
        el.mappingList.appendChild(row);
    }
}

async function loadMapping() {
    try {
        const result = await chrome.storage.sync.get('gestureMapping');
        if (result.gestureMapping) {
            const saved = { ...result.gestureMapping };
            // 移行: open は通常サインから除外されたため削除
            delete saved.open;
            currentMapping = { ...DEFAULT_MAPPING, ...saved };
        }
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('controlEnabled');
        if (result.controlEnabled !== undefined) {
            controlEnabled = result.controlEnabled;
            el.chkEnabled.checked = controlEnabled;
        }
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('wakeGestureType');
        if (result.wakeGestureType !== undefined) {
            // 移行: 旧モーション系ウェイクは廃止 → open にフォールバック
            const valid = ['open', 'none'];
            wakeGestureType = valid.includes(result.wakeGestureType)
                ? result.wakeGestureType : 'open';
        }
        const sel = $('sel-wake-gesture');
        if (sel) sel.value = wakeGestureType;
        // 初期状態を反映
        setWakeState(WAKE_STATE.IDLE);
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('wakeActiveDuration');
        if (result.wakeActiveDuration !== undefined) {
            wakeActiveDuration = Math.max(1000, Math.min(10000, Number(result.wakeActiveDuration) || WAKE_ACTIVE_DURATION));
        }
        const rng = $('rng-wake-timeout');
        if (rng) {
            rng.value = wakeActiveDuration / 1000;
            $('wake-timeout-value').textContent = fmtSeconds(wakeActiveDuration);
        }
        updateWakeUI();
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('toggleGestureType');
        if (result.toggleGestureType !== undefined) {
            const valid = ['frame', 'both-peace', 'peace-fist', 'none'];
            toggleGestureType = valid.includes(result.toggleGestureType)
                ? result.toggleGestureType : 'frame';
        }
        const sel = $('sel-toggle-gesture');
        if (sel) sel.value = toggleGestureType;
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('gestureHoldTime');
        if (result.gestureHoldTime !== undefined) {
            gestureHoldTime = Math.max(0, Math.min(500, Number(result.gestureHoldTime) || 0));
        }
        const rng = $('rng-hold-time');
        if (rng) {
            rng.value = gestureHoldTime;
            $('hold-time-value').textContent = fmtSeconds(gestureHoldTime);
        }
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('actionRepeatInterval');
        if (result.actionRepeatInterval !== undefined) {
            actionRepeatInterval = Math.max(200, Math.min(1000, Number(result.actionRepeatInterval) || 500));
        }
        const rng = $('rng-repeat-interval');
        if (rng) {
            rng.value = actionRepeatInterval;
            $('repeat-interval-value').textContent = fmtSeconds(actionRepeatInterval);
        }
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('skeletonOnly');
        if (result.skeletonOnly === true) applySkeletonOnly(true);
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('mirrorCamera');
        if (result.mirrorCamera === true) applyMirror(true);
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('inferenceFps');
        if (result.inferenceFps !== undefined) {
            const fps = Math.max(5, Math.min(30, Number(result.inferenceFps) || 15));
            tracker.targetFps = fps;
            const rng = $('rng-inference-fps');
            if (rng) {
                rng.value = fps;
                $('inference-fps-value').textContent = fmtFps(fps);
            }
        }
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('notifyVolume');
        if (result.notifyVolume !== undefined) {
            notifyVolume = Math.max(0, Math.min(1, Number(result.notifyVolume)));
        }
        const rng = $('rng-notify-volume');
        if (rng) {
            rng.value = Math.round(notifyVolume * 100);
            $('notify-volume-value').textContent = fmtVolume(notifyVolume);
        }
    } catch (_) {}
    // 表示サイズ
    try {
        const result = await chrome.storage.sync.get('uiScale');
        if (result.uiScale !== undefined) {
            uiScale = Math.max(80, Math.min(150, Number(result.uiScale)));
        }
        document.body.style.zoom = uiScale / 100;
        const rng = $('rng-ui-scale');
        if (rng) {
            rng.value = uiScale;
            $('ui-scale-value').textContent = fmtPercent(uiScale);
        }
    } catch (_) {}
    // PiP 文字サイズ
    try {
        const result = await chrome.storage.sync.get('pipFontScale');
        if (result.pipFontScale !== undefined) {
            const v = Math.max(50, Math.min(200, Number(result.pipFontScale)));
            const rng = $('rng-pip-font-scale');
            if (rng) {
                rng.value = v;
                $('pip-font-scale-value').textContent = fmtPercent(v);
            }
        }
    } catch (_) {}
    try {
        const result = await chrome.storage.local.get('selectedCameraId');
        if (result.selectedCameraId) selectedCameraId = result.selectedCameraId;
    } catch (_) {}
    try {
        const result = await chrome.storage.sync.get('preferredHand');
        if (result.preferredHand) {
            tracker.preferredHand = result.preferredHand;
            const sel = $('sel-preferred-hand');
            if (sel) sel.value = result.preferredHand;
        }
    } catch (_) {}
    // 折りたたみセクションの開閉状態を復元
    try {
        const result = await chrome.storage.sync.get(['collapse_section-settings', 'collapse_section-gestures']);
        for (const id of ['section-settings', 'section-gestures']) {
            const val = result[`collapse_${id}`];
            if (val !== undefined) $(id).open = val;
        }
    } catch (_) {}
}

async function saveMapping() {
    try { await chrome.storage.sync.set({ gestureMapping: currentMapping }); } catch (_) {}
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

el.chkMirror.addEventListener('change', () => {
    applyMirror(el.chkMirror.checked);
    chrome.storage.sync.set({ mirrorCamera: el.chkMirror.checked });
    // ユーザー操作なので自動復元をキャンセル
    savedMirrorState = null;
});

el.chkEnabled.addEventListener('change', () => {
    setControlEnabled(el.chkEnabled.checked);
});

/** メディア操作の有効/無効を一元的に切り替え */
function setControlEnabled(enabled) {
    controlEnabled = enabled;
    el.chkEnabled.checked = enabled;
    chrome.storage.sync.set({ controlEnabled });
    if (!enabled) {
        stopAllGestureActions();
        setWakeState(WAKE_STATE.IDLE);
    }
    playBeep(enabled ? 880 : 440, 0.2);
    log(enabled ? msg('logMediaControlOn') : msg('logMediaControlOff'));
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

/** 操作トグル変更時のログ用 i18n キーマッピング */
const TOGGLE_I18N_KEYS = {
    frame: 'optionToggleFrame', 'both-peace': 'optionToggleBothPeace',
    'peace-fist': 'optionTogglePeaceFist', none: 'optionToggleNone'
};
const selToggleGesture = $('sel-toggle-gesture');
selToggleGesture.addEventListener('change', () => {
    toggleGestureType = selToggleGesture.value;
    chrome.storage.sync.set({ toggleGestureType });
    log(msg('logToggleGestureChanged', [msg(TOGGLE_I18N_KEYS[toggleGestureType] || toggleGestureType)]));
});

const rngHoldTime = $('rng-hold-time');
rngHoldTime.addEventListener('input', () => {
    gestureHoldTime = Number(rngHoldTime.value);
    $('hold-time-value').textContent = fmtSeconds(gestureHoldTime);
    chrome.storage.sync.set({ gestureHoldTime });
});

const rngRepeatInterval = $('rng-repeat-interval');
rngRepeatInterval.addEventListener('input', () => {
    actionRepeatInterval = Number(rngRepeatInterval.value);
    $('repeat-interval-value').textContent = fmtSeconds(actionRepeatInterval);
    chrome.storage.sync.set({ actionRepeatInterval });
});

const rngInferenceFps = $('rng-inference-fps');
rngInferenceFps.addEventListener('input', () => {
    const fps = Number(rngInferenceFps.value);
    tracker.targetFps = fps;
    $('inference-fps-value').textContent = fmtFps(fps);
    chrome.storage.sync.set({ inferenceFps: fps });
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
    log(selPreferredHand.value === 'auto' ? msg('logPreferredHandAuto') : msg('logPreferredHandChanged', [selPreferredHand.value]));
});

el.btnReset.addEventListener('click', () => {
    currentMapping = { ...DEFAULT_MAPPING };
    saveMapping();
    buildMappingUI();
    log(msg('logMappingReset'));
});

$('btn-reset-settings').addEventListener('click', () => {
    // デフォルト値
    const defaults = {
        mirrorCamera: false, skeletonOnly: false,
        wakeGestureType: 'open', wakeActiveDuration: 5000,
        toggleGestureType: 'frame', preferredHand: 'auto',
        gestureHoldTime: 300, actionRepeatInterval: 1000,
        inferenceFps: 15, notifyVolume: 0.3,
        uiScale: 100, pipFontScale: 100,
    };

    // 状態変数を復元
    wakeGestureType = defaults.wakeGestureType;
    wakeActiveDuration = defaults.wakeActiveDuration;
    toggleGestureType = defaults.toggleGestureType;
    tracker.preferredHand = defaults.preferredHand;
    gestureHoldTime = defaults.gestureHoldTime;
    actionRepeatInterval = defaults.actionRepeatInterval;
    tracker.targetFps = defaults.inferenceFps;
    notifyVolume = defaults.notifyVolume;
    uiScale = defaults.uiScale;

    // UIを復元
    $('chk-mirror').checked = false; applyMirror(false);
    $('chk-skeleton-only').checked = false; applySkeletonOnly(false);
    $('sel-wake-gesture').value = defaults.wakeGestureType;
    $('rng-wake-timeout').value = defaults.wakeActiveDuration / 1000;
    $('wake-timeout-value').textContent = fmtSeconds(defaults.wakeActiveDuration);
    updateWakeUI();
    $('sel-toggle-gesture').value = defaults.toggleGestureType;
    $('sel-preferred-hand').value = defaults.preferredHand;
    $('rng-hold-time').value = defaults.gestureHoldTime;
    $('hold-time-value').textContent = fmtSeconds(defaults.gestureHoldTime);
    $('rng-repeat-interval').value = defaults.actionRepeatInterval;
    $('repeat-interval-value').textContent = fmtSeconds(defaults.actionRepeatInterval);
    $('rng-inference-fps').value = defaults.inferenceFps;
    $('inference-fps-value').textContent = fmtFps(defaults.inferenceFps);
    $('rng-notify-volume').value = Math.round(defaults.notifyVolume * 100);
    $('notify-volume-value').textContent = fmtVolume(defaults.notifyVolume);
    $('rng-ui-scale').value = defaults.uiScale;
    $('ui-scale-value').textContent = fmtPercent(defaults.uiScale);
    $('rng-pip-font-scale').value = defaults.pipFontScale;
    $('pip-font-scale-value').textContent = fmtPercent(defaults.pipFontScale);
    document.body.style.zoom = 1;

    // ストレージに保存
    chrome.storage.sync.set(defaults);
    log(msg('logSettingsReset'));
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

// 折りたたみセクションの開閉状態を永続化
for (const id of ['section-settings', 'section-gestures']) {
    const det = $(id);
    if (det) {
        det.addEventListener('toggle', () => {
            chrome.storage.sync.set({ [`collapse_${id}`]: det.open });
        });
    }
}

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
            log(msg('logPipReturned'));
            startCamera();
        }
    } catch (_) {}
}

init();
