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
    'point-right': 'gesturePointRight', 'point-left': 'gesturePointLeft',
    thumbsup: 'gestureThumbsup', thumbsdown: 'gestureThumbsdown',
    three: 'gestureThree', rock: 'gestureRock', four: 'gestureFour',
    open: 'gestureOpen', 'open-palm': 'gestureOpenPalm', unknown: 'gestureUnknown',
};
function gestureLabel(key) {
    return msg(GESTURE_I18N_KEYS[key] ?? 'gestureUnknown');
}

/** 設定のデフォルト値 — 設定読み込み・リセット両方で参照する唯一の定義 */
const DEFAULT_SETTINGS = {
    mirrorCamera: true, skeletonOnly: false,
    wakeGestureType: 'open', wakeActiveDuration: 5000,
    toggleGestureType: 'frame', preferredHand: 'auto',
    gestureHoldTime: 300, actionRepeatInterval: 1000,
    inferenceFps: 15, notifyVolume: 0.3,
    uiScale: 100, pipFontScale: 100,
};

const GESTURABLE_TYPES = [
    'fist', 'peace', 'three', 'four', 'ok', 'aloha', 'rock',
    'point-right', 'point-left', 'thumbsup', 'thumbsdown',
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
// ACTIVE: ウェイクサイン検出後、コマンドサインでアクション発火可能
const WAKE_STATE = { IDLE: 'idle', ACTIVE: 'active' };
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
let notifyVolume = DEFAULT_SETTINGS.notifyVolume;
let uiScale = DEFAULT_SETTINGS.uiScale;

// --- メタサイン（操作トグル）---
let toggleGestureType = DEFAULT_SETTINGS.toggleGestureType;
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

// --- ターゲットタブ固定 ---
let lockedTargetTabId = null;       // null = アクティブタブ追従, 数値 = 固定タブID

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
    const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
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

        // チュートリアル: カメラ起動でステップ自動進行
        if (tutorialActive && tutorialCurrentStep().autoAdvanceOn === 'camera-started') {
            advanceTutorial();
        }
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
            // チュートリアル: ウェイク発火でステップ自動進行
            if (tutorialActive && tutorialCurrentStep().autoAdvanceOn === 'wake-activated') {
                advanceTutorial();
            }
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

function isWakeGesture(gesture) {
    if (wakeGestureType === 'open') return gesture === 'open' || gesture === 'open-palm';
    return gesture === wakeGestureType;
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

    // ウェイクサインで ACTIVE に遷移
    if (wakeGestureType !== 'none' && isWakeGesture(gesture)) {
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
        const payload = { type: 'gesture-action', action };
        if (lockedTargetTabId) payload.targetTabId = lockedTargetTabId;
        await chrome.runtime.sendMessage(payload);
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
        const selToggle = $('sel-toggle-gesture');
        if (selToggle) selToggle.value = toggleGestureType;

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

        const fps = result.inferenceFps !== undefined
            ? Math.max(5, Math.min(30, Number(result.inferenceFps) || d.inferenceFps))
            : d.inferenceFps;
        tracker.targetFps = fps;
        const rngFps = $('rng-inference-fps');
        if (rngFps) {
            rngFps.value = fps;
            $('inference-fps-value').textContent = fmtFps(fps);
        }

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
        const result = await chrome.storage.local.get('selectedCameraId');
        if (result.selectedCameraId) selectedCameraId = result.selectedCameraId;
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
    log(selPreferredHand.value === 'auto'
        ? msg('logPreferredHandAuto')
        : msg('logPreferredHandChanged', [msg(selPreferredHand.value === 'Right' ? 'optionHandRight' : 'optionHandLeft')]));
});

el.btnReset.addEventListener('click', () => {
    currentMapping = { ...DEFAULT_MAPPING };
    saveMapping();
    buildMappingUI();
    log(msg('logMappingReset'));
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (lockedTargetTabId === tabId && changeInfo.title !== undefined) {
        $('target-tab-name').textContent = tab.title || String(tab.id);
        $('target-tab-name').title = tab.title || String(tab.id);
    }
});

$('btn-reset-settings').addEventListener('click', () => {
    const d = DEFAULT_SETTINGS;

    // 状態変数を復元
    wakeGestureType = d.wakeGestureType;
    wakeActiveDuration = d.wakeActiveDuration;
    toggleGestureType = d.toggleGestureType;
    tracker.preferredHand = d.preferredHand;
    gestureHoldTime = d.gestureHoldTime;
    actionRepeatInterval = d.actionRepeatInterval;
    tracker.targetFps = d.inferenceFps;
    notifyVolume = d.notifyVolume;
    uiScale = d.uiScale;

    // UIを復元
    $('chk-mirror').checked = d.mirrorCamera; applyMirror(d.mirrorCamera);
    $('chk-skeleton-only').checked = d.skeletonOnly; applySkeletonOnly(d.skeletonOnly);
    $('sel-wake-gesture').value = d.wakeGestureType;
    $('rng-wake-timeout').value = d.wakeActiveDuration / 1000;
    $('wake-timeout-value').textContent = fmtSeconds(d.wakeActiveDuration);
    updateWakeUI();
    $('sel-toggle-gesture').value = d.toggleGestureType;
    $('sel-preferred-hand').value = d.preferredHand;
    $('rng-hold-time').value = d.gestureHoldTime;
    $('hold-time-value').textContent = fmtSeconds(d.gestureHoldTime);
    $('rng-repeat-interval').value = d.actionRepeatInterval;
    $('repeat-interval-value').textContent = fmtSeconds(d.actionRepeatInterval);
    $('rng-inference-fps').value = d.inferenceFps;
    $('inference-fps-value').textContent = fmtFps(d.inferenceFps);
    $('rng-notify-volume').value = Math.round(d.notifyVolume * 100);
    $('notify-volume-value').textContent = fmtVolume(d.notifyVolume);
    $('rng-ui-scale').value = d.uiScale;
    $('ui-scale-value').textContent = fmtPercent(d.uiScale);
    $('rng-pip-font-scale').value = d.pipFontScale;
    $('pip-font-scale-value').textContent = fmtPercent(d.pipFontScale);
    document.body.style.zoom = d.uiScale / 100;

    // ストレージに保存
    chrome.storage.sync.set(d);
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
 * チュートリアル（初回起動時のガイド + 再表示ボタン）
 * ============================================================
 * モーダル + スポットライト方式。対象要素を clip-path で切り抜いて操作可能に保ち、
 * Next/Back/Skip + 主要アクション検出（カメラ開始・ウェイク発火）で自動進行。
 */
// targets は配列で複数要素を同時にハイライト可能（外接矩形で1つの切抜きにまとめる）
const TUTORIAL_STEPS = [
    { id: 'welcome', targets: [],                                       titleKey: 'tutorialStep1Title', bodyKey: 'tutorialStep1Body' },
    { id: 'camera',  targets: ['#camera-controls'],                     titleKey: 'tutorialStep2Title', bodyKey: 'tutorialStep2Body', autoAdvanceOn: 'camera-started' },
    { id: 'wake',    targets: ['#camera-section', '#gesture-section'],  titleKey: 'tutorialStep3Title', bodyKey: 'tutorialStep3Body', autoAdvanceOn: 'wake-activated' },
    { id: 'command', targets: ['#mapping-list'],                        titleKey: 'tutorialStep4Title', bodyKey: 'tutorialStep4Body' },
    // #chk-enabled は opacity:0 で 0x0。視認できる親ラベル + 「メディア操作」テキストを外接矩形化する
    { id: 'toggle',  targets: ['.header-label', 'label.toggle-switch:has(#chk-enabled)'], titleKey: 'tutorialStep5Title', bodyKey: 'tutorialStep5Body' },
    { id: 'pip',     targets: ['#btn-pip'],                             titleKey: 'tutorialStep6Title', bodyKey: 'tutorialStep6Body' },
];
let tutorialIndex = 0;
let tutorialActive = false;
let tutorialHighlightEls = [];

function tutorialCurrentStep() { return TUTORIAL_STEPS[tutorialIndex]; }

function startTutorial() {
    tutorialIndex = 0;
    tutorialActive = true;
    // チュートリアル中はメディア操作を自動でON（OFFだとウェイクが発火せずステップ進行が止まる）
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
    $('tutorial-indicator').textContent = msg('tutorialStepIndicator', [String(tutorialIndex + 1), String(total)]);
    $('tutorial-title').textContent = msg(step.titleKey);
    let bodyText;
    if (step.id === 'toggle') {
        if (toggleGestureType === 'none') {
            bodyText = msg('tutorialStep5BodyNoToggle');
        } else {
            const toggleName = msg(TOGGLE_I18N_KEYS[toggleGestureType] || '') || toggleGestureType;
            bodyText = msg('tutorialStep5Body', [toggleName]);
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

init();
