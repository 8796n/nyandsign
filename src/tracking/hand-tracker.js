/**
 * ハンドトラッキングモジュール
 *
 * MediaPipe HandLandmarker を使用してハンドサインを検出する。
 */

class HandTracker extends EventTarget {
    constructor() {
        super();
        this.handLandmarker = null;
        this.videoEl = null;
        this.canvasEl = null;
        this.ctx = null;
        this.running = false;
        this.skeletonOnly = false;
        this._rafId = null;

        // --- 推論スロットリング ---
        // targetFps: 推論の最大頻度。描画は毎rAFで前回結果を再利用する
        this.targetFps = 15;
        this._lastInferenceTime = 0;       // 前回推論の performance.now()
        this._lastVideoTime = -1;          // 前回推論時の video.currentTime
        this._lastResult = null;           // 前回推論結果キャッシュ（再描画用）
        this._lastHandData = [];           // 前回の手データ（描画用）
        this._drawDirty = false;           // 再描画が必要かどうか
        this.inferenceMaxWidth = 0;        // 0=原寸。指定時は推論入力だけ縮小する
        this._inferenceCanvas = null;
        this._inferenceCtx = null;
        this._lastInferenceSize = { width: 0, height: 0 };
        this.inferencePreprocess = 'none';
        this._lastOkDebug = null;          // 直近の判定デバッグ情報
        this._lastWakeOpenDebug = null;    // 直近のウェイク用パー判定情報

        // --- サイン安定化: 時間窓ベース多数決 + 切替ヒステリシス ---
        // サンプルはタイムスタンプ付きで保持し、時間窓内のみ集計
        this._gestureSamples = [];         // [{ gesture, time }]
        this._stabilizeWindowMs = 200;     // 多数決の時間窓 (ms)
        this._stableGesture = null;
        this._candidateGesture = null;
        this._candidateStartTime = 0;      // 候補の初出タイムスタンプ
        this._switchDwellMs = 100;         // 切替確定に必要な持続時間 (ms)
        this._okLatchUntil = 0;            // OKサインが一瞬欠落しても維持する期限
        this._okLatchMs = 500;             // OK維持ラッチの猶予時間

        // --- モーション検出用 ---
        this._trackedWrist = null;

        // --- 優先する手 ---
        // 'auto' = 追跡ベース, 'Left' / 'Right' = 指定した手を優先
        this.preferredHand = 'auto';

        // --- カメラ向き補正 ---
        // inputMirrored: 現在未使用（MediaPipe が handedness を正しく返すため swap 不要）
        // 将来的にカメラ種類で補正が必要になった場合に備えて残す
        this.inputMirrored = false;

        // displayMirrored: UI表示を CSS scaleX(-1) で反転しているかどうか
        // point-left/right の方向補正に使用
        this.displayMirrored = false;

        // --- PiP 対応: rAF ウィンドウ ---
        // PiP ウィンドウ使用時にそちらの rAF を使い、スロットリングを回避する
        this.animationWindow = window;
        this._loopGen = 0;     // rAF ループ世代番号（restartLoop 時に古いループを無効化）
    }

    get loaded() { return this.handLandmarker !== null; }

    /**
     * MediaPipe HandLandmarker をローカルファイルから読み込む。
     * MV3 拡張では CDN からの dynamic import が CSP でブロックされるためローカル必須。
     */
    async loadModel(onProgress) {
        if (this.handLandmarker) return;

        onProgress?.('mediaPipeLoading');
        const bundleUrl = chrome.runtime?.getURL
            ? chrome.runtime.getURL('lib/mediapipe/vision_bundle.mjs')
            : 'lib/mediapipe/vision_bundle.mjs';
        const vision = await import(bundleUrl);
        const { HandLandmarker, FilesetResolver } = vision;

        onProgress?.('mediaPipeWasm');
        const wasmPath = chrome.runtime?.getURL
            ? chrome.runtime.getURL('lib/mediapipe/wasm')
            : 'lib/mediapipe/wasm';
        const wasmFileset = await FilesetResolver.forVisionTasks(wasmPath);

        onProgress?.('mediaPipeModel');
        const modelPath = chrome.runtime?.getURL
            ? chrome.runtime.getURL('lib/mediapipe/models/hand_landmarker.task')
            : 'lib/mediapipe/models/hand_landmarker.task';

        try {
            this.handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
                baseOptions: {
                    modelAssetPath: modelPath,
                    delegate: 'GPU',
                },
                runningMode: 'VIDEO',
                numHands: 2,
            });
        } catch (e) {
            // GPU 失敗時は CPU にフォールバック
            onProgress?.('mediaPipeGpuFallback');
            this.handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
                baseOptions: {
                    modelAssetPath: modelPath,
                    delegate: 'CPU',
                },
                runningMode: 'VIDEO',
                numHands: 2,
            });
        }

        onProgress?.('mediaPipeReady');
    }

    /**
     * カメラを開始してトラッキングを開始する。
     * @param {HTMLVideoElement} videoEl
     * @param {HTMLCanvasElement} canvasEl
     * @param {object} options - { width, height, skeletonOnly }
     */
    async start(videoEl, canvasEl, options = {}) {
        if (!this.handLandmarker) throw new Error('model not loaded');

        this.videoEl = videoEl;
        this.canvasEl = canvasEl;
        this.ctx = canvasEl.getContext('2d');
        this.skeletonOnly = options.skeletonOnly ?? false;
        this.running = true;

        this._loopGen++;
        this._tick();
    }

    /**
     * トラッキングを停止する。
     */
    stop() {
        this.running = false;
        this._loopGen++;
        if (this._rafId) {
            try { (this.animationWindow || window).cancelAnimationFrame(this._rafId); } catch (_) {}
            this._rafId = null;
        }
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
        }
        // 安定中のサインがあればクリアイベントを発火
        if (this._stableGesture !== null) {
            this._stableGesture = null;
            this.dispatchEvent(new CustomEvent('gesture', {
                detail: { gesture: null }
            }));
        }
        // 状態リセット
        this._trackedWrist = null;
        this._lastInferenceTime = 0;
        this._lastVideoTime = -1;
        this._lastResult = null;
        this._lastHandData = [];
        this._drawDirty = false;
        this._lastInferenceSize = { width: 0, height: 0 };
        // サイン状態リセット
        this._gestureSamples = [];
        this._candidateGesture = null;
        this._candidateStartTime = 0;
    }

    /**
     * animationWindow 変更後にループを再始動する。
     * 古いウィンドウの rAF チェーンを世代番号で無効化し、新しいウィンドウでループを開始する。
     */
    restartLoop() {
        if (!this.running) return;
        this._loopGen++;
        this._tick();
    }

    /**
     * Canvas の 2D コンテキストを再取得する。
     * DOM 要素が別ドキュメントに移動された後に呼び出す。
     */
    refreshContext() {
        if (this.canvasEl) {
            this.ctx = this.canvasEl.getContext('2d');
        }
    }

    /**
     * フレームループ（毎rAF呼出し）
     * 推論は targetFps に制限し、描画は毎フレーム前回結果を再利用する。
     */
    _tick() {
        if (!this.running) return;
        const gen = this._loopGen;
        this._rafId = (this.animationWindow || window).requestAnimationFrame(() => {
            if (this._loopGen !== gen) return;
            this._tick();
        });

        const video = this.videoEl;
        if (!video || video.readyState < 2) return;

        // Canvas サイズ同期（リサイズ時は再描画が必要）
        if (this.canvasEl.width !== video.videoWidth || this.canvasEl.height !== video.videoHeight) {
            this.canvasEl.width = video.videoWidth;
            this.canvasEl.height = video.videoHeight;
            this._drawDirty = true;
        }

        const now = performance.now();
        const minInterval = 1000 / this.targetFps;
        const isNewFrame = video.currentTime > this._lastVideoTime;

        // 推論: 新しいビデオフレーム & FPSキャップ以内
        if (isNewFrame && (now - this._lastInferenceTime) >= minInterval) {
            this._lastInferenceTime = now;
            this._lastVideoTime = video.currentTime;
            this._runInference(video, now);
            // _runInference 内で _lastHandData が更新される → 再描画
            this._drawDirty = true;
        }

        // 描画: 新しい推論結果 or リサイズ時のみ
        if (this._drawDirty) {
            this._drawDirty = false;
            this._drawCachedResult();
        }
    }

    /**
     * MediaPipe 推論を実行し、結果をキャッシュ + サイン更新
     */
    _runInference(video, now) {
        const source = this._prepareInferenceSource(video);
        const result = this.handLandmarker.detectForVideo(source, now);
        this._lastResult = result;

        if (!result || !result.landmarks || result.landmarks.length === 0) {
            this._lastHandData = [];
            this._updateGesture(null, now, { gestures: [] });
            return;
        }

        // 追跡対象の手を選択（前フレームの手首に最も近い手）
        const primaryIdx = this._selectPrimaryHand(result.landmarks);

        // 各手のデータを構築
        const hands = [];
        for (let i = 0; i < result.landmarks.length; i++) {
            const lm = result.landmarks[i];
            const wlm = result.worldLandmarks?.[i] ?? null;
            const rawHand = result.handednesses?.[i]?.[0]?.categoryName ?? 'unknown';
            const hand = rawHand;

            const gesture = this._detectGesture(lm, hand, wlm);
            const okDebug = this._lastOkDebug
                ? { ...this._lastOkDebug, rawGesture: gesture, hand }
                : null;
            const wakeOpenDebug = this._lastWakeOpenDebug
                ? { ...this._lastWakeOpenDebug, rawGesture: gesture, hand }
                : null;
            if (okDebug && wakeOpenDebug) okDebug.wakeOpenDebug = wakeOpenDebug;
            hands.push({
                hand,
                gesture,
                landmarks: lm,
                idx: i,
                okDebug,
                wakeOpen: wakeOpenDebug?.eligible === true,
                wakeOpenDebug,
            });
        }

        this._lastHandData = hands;

        // 優先手の決定
        let activeIdx;
        if (this.preferredHand === 'auto') {
            activeIdx = primaryIdx;
        } else {
            const prefIdx = hands.findIndex(g => g.hand === this.preferredHand);
            activeIdx = prefIdx >= 0 ? prefIdx : primaryIdx;
        }

        let activeGesture = hands[activeIdx]?.gesture ?? null;

        // 優先手がコマンドサインでない場合、
        // もう片方の手の指差し系サインを受け付ける
        const POINT_GESTURES = ['point-left', 'point-right', 'point-up'];
        const COMMAND_GESTURES = [
            'ok', 'fist', 'thumbsup', 'thumbsdown', 'peace', 'aloha',
            ...POINT_GESTURES,
            'open', 'open-palm',
        ];
        if (!COMMAND_GESTURES.includes(activeGesture)) {
            for (const g of hands) {
                if (g.idx !== activeIdx && POINT_GESTURES.includes(g.gesture)) {
                    activeGesture = g.gesture;
                    break;
                }
            }
        }

        const gestureBeforeOkLatch = activeGesture;
        activeGesture = this._applyOkLatch(activeGesture, hands, activeIdx, now);
        if (activeGesture === 'ok' && gestureBeforeOkLatch !== activeGesture && activeIdx >= 0 && hands[activeIdx]) {
            hands[activeIdx].gesture = activeGesture;
        }

        // 主手の手首座標を記録（手の追跡用）
        const wristIdx = activeIdx >= 0 ? activeIdx : 0;
        if (wristIdx < result.landmarks.length) {
            const wrist = result.landmarks[wristIdx][0];
            this._trackedWrist = { x: wrist.x, y: wrist.y };
        }

        this._updateGesture(activeGesture, now, { gestures: hands, activeIdx });

        // 詳細イベント
        this.dispatchEvent(new CustomEvent('frame', {
            detail: {
                gestures: hands,
                handCount: result.landmarks.length,
                activeIdx,
                activeGesture,
                stableGesture: this._stableGesture,
            }
        }));
    }

    setInferenceMaxWidth(maxWidth) {
        const n = Number(maxWidth);
        this.inferenceMaxWidth = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
        this._lastInferenceSize = { width: 0, height: 0 };
    }

    setInferencePreprocess(mode) {
        const normalized = mode === 'mono-contrast' ? 'mono-contrast' : 'none';
        if (this.inferencePreprocess === normalized) return;
        this.inferencePreprocess = normalized;
        this._lastInferenceSize = { width: 0, height: 0 };
    }

    getInferenceInputSize() {
        const video = this.videoEl;
        return this._resolveInferenceInputSize(video?.videoWidth || 0, video?.videoHeight || 0);
    }

    _resolveInferenceInputSize(sourceWidth, sourceHeight) {
        if (!sourceWidth || !sourceHeight) return { width: 0, height: 0 };
        const maxWidth = this.inferenceMaxWidth;
        if (!maxWidth || sourceWidth <= maxWidth) {
            return { width: sourceWidth, height: sourceHeight };
        }
        const scale = maxWidth / sourceWidth;
        return {
            width: Math.max(1, Math.round(sourceWidth * scale)),
            height: Math.max(1, Math.round(sourceHeight * scale)),
        };
    }

    _prepareInferenceSource(video) {
        const size = this._resolveInferenceInputSize(video.videoWidth, video.videoHeight);
        this._lastInferenceSize = size;
        const needsPreprocess = this.inferencePreprocess === 'mono-contrast';

        if (!needsPreprocess && (!this.inferenceMaxWidth || size.width === video.videoWidth)) return video;

        if (!this._inferenceCanvas) {
            const doc = this.canvasEl?.ownerDocument || document;
            this._inferenceCanvas = doc.createElement('canvas');
            this._inferenceCtx = this._inferenceCanvas.getContext('2d', { alpha: false });
        }
        if (this._inferenceCanvas.width !== size.width || this._inferenceCanvas.height !== size.height) {
            this._inferenceCanvas.width = size.width;
            this._inferenceCanvas.height = size.height;
        }
        this._drawInferenceFrame(video, size.width, size.height, needsPreprocess);
        if (needsPreprocess) this._applyMonoContrast(this._inferenceCtx, size.width, size.height);
        return this._inferenceCanvas;
    }

    _drawInferenceFrame(video, width, height, smooth) {
        const ctx = this._inferenceCtx;
        if (!smooth) {
            ctx.drawImage(video, 0, 0, width, height);
            return;
        }

        // 6DoF 用白黒カメラの粒状ノイズを少し落としてから推論へ渡す。
        ctx.save();
        try {
            ctx.filter = 'blur(0.7px)';
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'medium';
            ctx.drawImage(video, 0, 0, width, height);
        } finally {
            ctx.restore();
        }
    }

    _applyMonoContrast(ctx, width, height) {
        if (!width || !height) return;

        const image = ctx.getImageData(0, 0, width, height);
        const data = image.data;
        const hist = new Uint32Array(256);
        const total = width * height;

        for (let i = 0; i < data.length; i += 4) {
            const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
            hist[y]++;
        }

        const lowTarget = Math.floor(total * 0.01);
        const highTarget = Math.ceil(total * 0.99);
        let sum = 0;
        let lo = 0;
        for (; lo < 255; lo++) {
            sum += hist[lo];
            if (sum >= lowTarget) break;
        }
        sum = 0;
        let hi = 255;
        for (; hi > 0; hi--) {
            sum += hist[hi];
            if (sum >= total - highTarget) break;
        }
        if (hi <= lo) return;

        const scale = 255 / (hi - lo);
        const gamma = 0.78;
        for (let i = 0; i < data.length; i += 4) {
            const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
            const v = Math.max(0, Math.min(255, Math.round((y - lo) * scale)));
            // 暗い6DoF用映像は中間調を少し持ち上げて手の表面特徴を残す。
            const bright = Math.round(Math.pow(v / 255, gamma) * 255);
            data[i] = bright;
            data[i + 1] = bright;
            data[i + 2] = bright;
            data[i + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
    }

    /**
     * 前回推論結果をもとにキャンバスに描画
     */
    _drawCachedResult() {
        const ctx = this.ctx;
        const W = this.canvasEl.width;
        const H = this.canvasEl.height;

        if (this.skeletonOnly) {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
        } else {
            ctx.clearRect(0, 0, W, H);
        }

        for (const hd of this._lastHandData) {
            this._drawHand(ctx, hd.landmarks, W, H, hd.hand);
        }
    }

    /**
     * サイン安定化: 時間窓ベース多数決 + 切替ヒステリシス
     * _stabilizeWindowMs (200ms) 内のサンプルで多数決。
     * 切替候補が _switchDwellMs (100ms) 以上持続したら確定。
     * null（手なし）は即座に反映 → リピート等を速やかに停止。
     */
    _updateGesture(gesture, now, detail = {}) {
        // null（手なし）: 即座に安定サインをクリアしてイベント発火
        // サンプル・候補は安定状態に関係なく常にクリアする（再出現時の誤判定防止）
        if (gesture === null) {
            this._gestureSamples = [];
            this._candidateGesture = null;
            this._candidateStartTime = 0;
            this._okLatchUntil = 0;
            if (this._stableGesture !== null) {
                this._stableGesture = null;
                this.dispatchEvent(new CustomEvent('gesture', {
                    detail: { gesture: null, ...detail }
                }));
            }
            return;
        }

        // サンプル追加（タイムスタンプ付き）
        this._gestureSamples.push({ gesture, time: now });

        // 時間窓外のサンプルを除去
        const cutoff = now - this._stabilizeWindowMs;
        while (this._gestureSamples.length > 0 && this._gestureSamples[0].time < cutoff) {
            this._gestureSamples.shift();
        }

        // 時間窓内で多数決
        const counts = new Map();
        for (const s of this._gestureSamples) {
            counts.set(s.gesture, (counts.get(s.gesture) || 0) + 1);
        }

        let winner = null;
        let winnerCount = 0;
        for (const [g, c] of counts.entries()) {
            if (c > winnerCount) { winner = g; winnerCount = c; }
        }

        // 過半数に満たなければ現状維持
        const total = this._gestureSamples.length;
        if (total < 2 || winnerCount <= total / 2) return;

        // 既に安定中なら何もしない
        if (winner === this._stableGesture) {
            this._candidateGesture = null;
            this._candidateStartTime = 0;
            return;
        }

        // 切替候補の追跡（時間ベースヒステリシス）
        if (winner !== this._candidateGesture) {
            this._candidateGesture = winner;
            this._candidateStartTime = now;
            return;
        }

        // 候補が _switchDwellMs 以上持続したら確定
        if ((now - this._candidateStartTime) >= this._switchDwellMs) {
            this._stableGesture = winner;
            this._candidateGesture = null;
            this._candidateStartTime = 0;

            this.dispatchEvent(new CustomEvent('gesture', {
                detail: { gesture: winner, ...detail }
            }));
        }
    }

    /**
     * OKサインは角度によって open/four/unknown に揺れやすいため、直近でOKだった場合だけ短時間維持する。
     * 初回検出は通常のOK条件に任せ、ラッチは「保持中の欠落補正」に限定する。
     */
    _applyOkLatch(activeGesture, hands, activeIdx, now) {
        const active = hands[activeIdx];
        const debug = active?.okDebug;

        if (activeGesture === 'ok') {
            this._okLatchUntil = now + this._okLatchMs;
            if (debug) debug.okLatched = false;
            return activeGesture;
        }

        const wasOkRecently = this._stableGesture === 'ok' || now <= this._okLatchUntil;
        if (!wasOkRecently || !debug) return activeGesture;

        const isOpenGesture = activeGesture === 'open' || activeGesture === 'open-palm';
        const extendableOkShape = isOpenGesture
            ? debug.otherExtendedCount >= 2 &&
                debug.thumbIndexOkDist < 0.72 &&
                debug.thumbIndexTipDist < 0.90
            : debug.otherExtendedCount >= 2 &&
                debug.thumbIndexOkDist < 0.82 &&
                debug.thumbIndexTipDist < 1.05;
        const shortOcclusionOkShape =
            debug.okPinch &&
            debug.strongOkPinch &&
            debug.thumbIndexTipDist < 0.70;

        if (extendableOkShape) {
            // open/open-palm は意図的なウェイクサインでもあるため、ラッチ期限を延長しない
            if (!isOpenGesture) this._okLatchUntil = now + this._okLatchMs;
            debug.okLatched = true;
            return 'ok';
        }

        if (shortOcclusionOkShape && now <= this._okLatchUntil) {
            debug.okLatched = true;
            return 'ok';
        }

        debug.okLatched = false;
        return activeGesture;
    }

    /**
     * 手の骨格を描画する。
     */
    _drawHand(ctx, landmarks, W, H, handedness = 'unknown') {
        const CONNECTIONS = [
            [0,1],[1,2],[2,3],[3,4],       // 親指
            [0,5],[5,6],[6,7],[7,8],       // 人差し指
            [0,9],[9,10],[10,11],[11,12],   // 中指
            [0,13],[13,14],[14,15],[15,16], // 薬指
            [0,17],[17,18],[18,19],[19,20], // 小指
            [5,9],[9,13],[13,17],           // 手のひら横
        ];

        // 左右の手で骨格色を変える
        const isLeft = handedness === 'Left';
        const lineColor = isLeft ? '#44ccff' : '#00ff88';
        const dotColor  = isLeft ? '#ffcc44' : '#ff4466';

        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;

        for (const [a, b] of CONNECTIONS) {
            ctx.beginPath();
            ctx.moveTo(landmarks[a].x * W, landmarks[a].y * H);
            ctx.lineTo(landmarks[b].x * W, landmarks[b].y * H);
            ctx.stroke();
        }

        for (const pt of landmarks) {
            ctx.beginPath();
            ctx.arc(pt.x * W, pt.y * H, 3, 0, Math.PI * 2);
            ctx.fillStyle = dotColor;
            ctx.fill();
        }
    }

    /**
     * 追跡対象の手を選択する。
     * 前フレームの手首に最も近い手を選ぶことで、手インデックスの入れ替わりに対応。
     */
    _selectPrimaryHand(allLandmarks) {
        if (allLandmarks.length === 0) return -1;
        if (allLandmarks.length === 1 || !this._trackedWrist) {
            return 0;
        }
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < allLandmarks.length; i++) {
            const w = allLandmarks[i][0];
            const d = (w.x - this._trackedWrist.x) ** 2 + (w.y - this._trackedWrist.y) ** 2;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    /* ============================================================
     * ジオメトリヘルパー
     * ============================================================ */

    _dist(a, b) {
        const dx = a.x - b.x, dy = a.y - b.y;
        const dz = (a.z ?? 0) - (b.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    _avgPoint(points) {
        let x = 0, y = 0, z = 0;
        for (const p of points) { x += p.x; y += p.y; z += (p.z ?? 0); }
        const n = points.length;
        return { x: x / n, y: y / n, z: z / n };
    }

    _sub(a, b) {
        return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
    }

    _dot(a, b) {
        return a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
    }

    _cross(a, b) {
        return {
            x: a.y * (b.z ?? 0) - (a.z ?? 0) * b.y,
            y: (a.z ?? 0) * b.x - a.x * (b.z ?? 0),
            z: a.x * b.y - a.y * b.x,
        };
    }

    _vecLen(v) {
        return Math.sqrt(v.x * v.x + v.y * v.y + (v.z ?? 0) * (v.z ?? 0));
    }

    _pointSegmentDist(p, a, b) {
        const ab = this._sub(b, a);
        const ap = this._sub(p, a);
        const denom = this._dot(ab, ab);
        if (denom < 1e-8) return this._dist(p, a);
        const t = Math.max(0, Math.min(1, this._dot(ap, ab) / denom));
        const closest = {
            x: a.x + ab.x * t,
            y: a.y + ab.y * t,
            z: (a.z ?? 0) + (ab.z ?? 0) * t,
        };
        return this._dist(p, closest);
    }

    _normalize(v) {
        const n = this._vecLen(v);
        if (n < 1e-6) return { x: 0, y: 0, z: 0 };
        return { x: v.x / n, y: v.y / n, z: (v.z ?? 0) / n };
    }

    _toDegrees(rad) {
        return rad * 180 / Math.PI;
    }

    _getPalmFaceOn(lm) {
        if (!lm?.[0] || !lm?.[5] || !lm?.[9] || !lm?.[17]) return 0;
        const palmAxis = this._sub(lm[9], lm[0]);
        const palmWidth = this._sub(lm[17], lm[5]);
        const normal = this._normalize(this._cross(palmAxis, palmWidth));
        const palmHeight = this._dist(lm[0], lm[9]);
        const palmWidthLength = this._dist(lm[5], lm[17]);
        const palmSpreadRatio = palmHeight > 1e-6 ? palmWidthLength / palmHeight : 0;
        return {
            normalScore: Math.abs(normal.z ?? 0),
            palmSpreadRatio,
        };
    }

    _getPalmNormal(points) {
        if (!points?.[0] || !points?.[5] || !points?.[9] || !points?.[17]) return null;
        const palmAxis = this._sub(points[9], points[0]);
        const palmWidth = this._sub(points[17], points[5]);
        return this._normalize(this._cross(palmAxis, palmWidth));
    }

    _getPalmOrientation(lm, worldLm) {
        if (!lm?.[0] || !lm?.[9]) return null;

        const palmAxis2d = this._sub(lm[9], lm[0]);
        const rollX = this.displayMirrored ? -palmAxis2d.x : palmAxis2d.x;
        const rollDeg = this._toDegrees(Math.atan2(rollX, -palmAxis2d.y));
        const points = worldLm ?? lm;
        const normal = this._getPalmNormal(points);
        if (!normal) {
            return {
                rollDeg,
                yawDeg: NaN,
                pitchDeg: NaN,
                faceDeg: NaN,
                source: 'none',
            };
        }

        const viewNormal = (normal.z ?? 0) < 0
            ? { x: -normal.x, y: -normal.y, z: -(normal.z ?? 0) }
            : normal;
        const z = Math.max(Math.abs(viewNormal.z ?? 0), 1e-6);
        const yawRaw = this._toDegrees(Math.atan2(viewNormal.x, z));
        const yawDeg = this.displayMirrored ? -yawRaw : yawRaw;
        const pitchDeg = this._toDegrees(Math.atan2(viewNormal.y, z));
        const faceDeg = this._toDegrees(Math.atan2(
            Math.hypot(viewNormal.x, viewNormal.y),
            z
        ));

        return {
            rollDeg,
            yawDeg,
            pitchDeg,
            faceDeg,
            source: worldLm ? 'world' : 'image',
        };
    }

    _fingerPlaneComponent(points, palmNormal, mcp, tip) {
        if (!points?.[mcp] || !points?.[tip] || !palmNormal) return 0;
        const axis = this._normalize(this._sub(points[tip], points[mcp]));
        return Math.abs(this._dot(axis, palmNormal));
    }

    /* ============================================================
     * 手のひらジオメトリ計算
     * worldLandmarks があれば距離計算に使用（視点依存が小さい）
     * ============================================================ */

    /**
     * 手のひらが カメラ側を向いているか判定。
     * index MCP(5)→wrist(0) と index MCP(5)→pinky MCP(17) の外積で掌の法線を求め、
     * z成分の符号で表裏を判定する（image landmarks の z を使用）。
     */
    _isPalmFacing(lm, handedness = 'unknown') {
        const a = this._sub(lm[0], lm[5]);   // index MCP → wrist
        const b = this._sub(lm[17], lm[5]);  // index MCP → pinky MCP
        // 外積の z 成分: a.x*b.y - a.y*b.x
        const crossZ = a.x * b.y - a.y * b.x;
        if (handedness === 'Left') return crossZ < 0;
        return crossZ > 0;
    }

    _getPalmGeometry(lm, worldLm, handedness = 'unknown') {
        const g = worldLm ?? lm;
        const palmCenter = this._avgPoint([g[0], g[5], g[9], g[13], g[17]]);
        const palmWidth = this._dist(g[5], g[17]);
        const palmHeight = this._dist(g[0], g[9]);
        const palmSize = (palmWidth + palmHeight) * 0.5;

        // 手のローカル軸: wrist → middle MCP
        const u = this._normalize(this._sub(g[9], g[0]));

        // 2D palmSize（thumbsup/down の画面座標判定用）
        const pw2d = this._dist(lm[5], lm[17]);
        const ph2d = this._dist(lm[0], lm[9]);
        const palmSize2D = (pw2d + ph2d) * 0.5;

        const minSize = worldLm ? 0.015 : 0.04;
        if (!Number.isFinite(palmSize) || palmSize < minSize) return null;

        // handedness を使って左右で一貫した掌/手の甲判定に揃える
        const palmFacing = this._isPalmFacing(lm, handedness);

        return { g, palmCenter, palmSize, palmSize2D, u, palmFacing };
    }

    /**
     * 4本指 (人差し/中/薬/小) の curled / extended 判定
     * 距離ベース + ローカル軸投影で角度非依存
     * 手の甲向き時は閾値を緩和（ランドマーク精度低下に対応）
     */
    _getFingerState(g, palmCenter, palmSize, u, mcp, pip, tip, palmFacing) {
        const tipDist = this._dist(g[tip], palmCenter) / palmSize;
        const pipDist = this._dist(g[pip], palmCenter) / palmSize;
        const tipAlong = this._dot(this._sub(g[tip], palmCenter), u) / palmSize;
        const pipAlong = this._dot(this._sub(g[pip], palmCenter), u) / palmSize;
        const directLength = this._dist(g[mcp], g[tip]);
        const pathLength = this._dist(g[mcp], g[pip]) + this._dist(g[pip], g[tip]);
        const straightness = pathLength > 1e-6 ? directLength / pathLength : 1;
        const bentForOk = straightness < (palmFacing ? 0.94 : 0.92);

        // 手の甲向き: 自己遮蔽でランドマークがブレるため閾値を緩和
        const curledTipTh  = palmFacing ? 0.95 : 1.05;
        const curledAlongM = palmFacing ? 0.05 : 0.10;
        const extTipTh     = palmFacing ? 1.05 : 0.95;
        const extAlongM    = palmFacing ? 0.08 : 0.05;

        const curled   = tipDist < curledTipTh && tipAlong < pipAlong + curledAlongM;
        const extended = tipDist > extTipTh    && tipAlong > pipAlong + extAlongM;

        return { tipDist, curled, extended, straightness, bentForOk };
    }

    /**
     * 親指の状態判定（fist 用 folded / thumbsup 用 extendedAway）
     * 親指は他4指と構造が異なるため別ルール
     */
    _getThumbState(g, palmCenter, palmSize, lm, palmSize2D, palmFacing) {
        const thumbPalmDist = this._dist(g[4], palmCenter) / palmSize;
        const thumbIndexMcpDist = this._dist(g[4], g[5]) / palmSize;
        const thumbMiddleMcpDist = this._dist(g[4], g[9]) / palmSize;
        const thumbIndexTipDist = this._dist(g[4], g[8]) / palmSize;
        const thumbIndexSegmentDist = Math.min(
            this._pointSegmentDist(g[4], g[6], g[7]),
            this._pointSegmentDist(g[4], g[7], g[8])
        ) / palmSize;
        const thumbIndexOkDist = Math.min(thumbIndexTipDist, thumbIndexSegmentDist);

        // 手の甲向き: 親指の遮蔽が大きいため閾値を緩和
        const foldPalmTh    = palmFacing ? 0.95 : 1.05;
        const foldIdxMcpTh  = palmFacing ? 0.75 : 0.85;
        const foldMidMcpTh  = palmFacing ? 0.95 : 1.05;
        const extPalmTh     = palmFacing ? 0.95 : 0.85;
        const extIdxMcpTh   = palmFacing ? 0.70 : 0.60;

        const folded =
            thumbPalmDist < foldPalmTh &&
            (thumbIndexMcpDist < foldIdxMcpTh || thumbMiddleMcpDist < foldMidMcpTh);

        const extendedAway =
            thumbPalmDist > extPalmTh &&
            thumbIndexMcpDist > extIdxMcpTh;

        // 画面座標で上下判定（image landmarks を使用）
        // aboveWrist: 0.35→0.20 に緩和（上向きは自然姿勢でないため差が小さい）
        const aboveWrist = (lm[0].y - lm[4].y) > 0.20 * palmSize2D;
        const belowWrist = (lm[4].y - lm[0].y) > 0.20 * palmSize2D;

        return { thumbPalmDist, thumbIndexTipDist, thumbIndexOkDist, folded, extendedAway, aboveWrist, belowWrist };
    }

    /**
     * 人差し指の向きから指差し方向を判定する。
     * 画面座標を palmSize2D で正規化し、上向きまたは横向きが十分強い場合のみ返す。
     */
    _getPointDirection(lm, palmSize2D) {
        if (!Number.isFinite(palmSize2D) || palmSize2D <= 0) return null;

        // tip だけだと左右端でブレやすいため、人差し指全体の軸を重み付きで使う
        const dx = (
            (lm[6].x - lm[5].x) * 0.2 +
            (lm[7].x - lm[5].x) * 0.3 +
            (lm[8].x - lm[5].x) * 0.5
        ) / palmSize2D;
        const dy = (
            (lm[6].y - lm[5].y) * 0.2 +
            (lm[7].y - lm[5].y) * 0.3 +
            (lm[8].y - lm[5].y) * 0.5
        ) / palmSize2D;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (dy <= -0.42 && absDy >= absDx * 1.05) return 'point-up';

        if (absDx < 0.42) return null;
        if (absDx < absDy) return null;

        // 表示ミラーモード: 画像空間の左右と表示空間の左右が反転
        const imageLeft = dx < 0;
        if (this.displayMirrored) {
            return imageLeft ? 'point-right' : 'point-left';
        }
        return imageLeft ? 'point-left' : 'point-right';
    }

    /* ============================================================
     * ハンドサイン判定（距離ベース）
     *
     * 判定順: ok → aloha → rock → thumbsup/down → fist → point-left/right/up → three → peace → four → open/open-palm
     * 距離は palmSize で正規化 → カメラ距離・手の大きさに非依存
     * ============================================================ */

    _detectGesture(lm, handedness, worldLm = null) {
        const palm = this._getPalmGeometry(lm, worldLm, handedness);
        this._lastOkDebug = null;
        this._lastWakeOpenDebug = null;
        if (!palm) return 'unknown';

        const { g, palmCenter, palmSize, palmSize2D, u, palmFacing } = palm;

        const index  = this._getFingerState(g, palmCenter, palmSize, u, 5,  6,  8, palmFacing);
        const middle = this._getFingerState(g, palmCenter, palmSize, u, 9, 10, 12, palmFacing);
        const ring   = this._getFingerState(g, palmCenter, palmSize, u, 13, 14, 16, palmFacing);
        const pinky  = this._getFingerState(g, palmCenter, palmSize, u, 17, 18, 20, palmFacing);
        const thumb  = this._getThumbState(g, palmCenter, palmSize, lm, palmSize2D, palmFacing);

        const fingers = [index, middle, ring, pinky];
        const curledCount = fingers.filter(f => f.curled).length;
        const extendedCount = fingers.filter(f => f.extended).length;
        const avgTipDist = fingers.reduce((s, f) => s + f.tipDist, 0) / 4;
        const otherExtendedCount = [middle, ring, pinky].filter(f => f.extended).length;
        const normalOkPinch = thumb.thumbIndexOkDist < 0.65;
        const strongOkPinch = thumb.thumbIndexOkDist < 0.45;
        const relaxedBentIndexOkPinch =
            !index.extended &&
            otherExtendedCount >= 2 &&
            thumb.thumbIndexOkDist < 0.74 &&
            thumb.thumbIndexTipDist < 0.95;
        const okPinch = normalOkPinch || relaxedBentIndexOkPinch;
        const indexExtendedOkPinch =
            index.extended &&
            index.bentForOk &&
            otherExtendedCount >= 2 &&
            thumb.thumbIndexOkDist < 0.66 &&
            thumb.thumbIndexTipDist < 0.82;
        const strongIndexOkPinch =
            strongOkPinch &&
            (!index.extended || (index.bentForOk && thumb.thumbIndexTipDist < 0.82));
        const okIndexAllowed = !index.extended || strongIndexOkPinch || indexExtendedOkPinch;
        const fourThumbPalmTh = palmFacing ? 0.86 : 0.90;
        const fourThumbAwayFromIndexTh = palmFacing ? 0.70 : 0.65;
        const fourThumbTucked =
            thumb.folded &&
            !thumb.extendedAway &&
            thumb.thumbPalmDist < fourThumbPalmTh &&
            thumb.thumbIndexOkDist > fourThumbAwayFromIndexTh;
        const okFailureReason = !okPinch
            ? 'pinch-too-far'
            : otherExtendedCount < 2
                ? 'other-fingers-not-extended'
                : !okIndexAllowed
                    ? 'index-extended'
                    : 'matched';
        // ウェイク用のパーは通常判定より厳しくし、手の面がカメラ正面に近い場合だけ許可する。
        const wakeOpenFaceOn = this._getPalmFaceOn(lm);
        const wakeOpenFaceOnScore = wakeOpenFaceOn.normalScore;
        const wakeOpenPalmSpread = wakeOpenFaceOn.palmSpreadRatio;
        const wakeOpenWorldFaceOn = worldLm ? this._getPalmFaceOn(worldLm) : null;
        const wakeOpenWorldFaceOnScore = wakeOpenWorldFaceOn?.normalScore ?? Infinity;
        const wakeOpenOrientation = this._getPalmOrientation(lm, worldLm);
        const wakeOpenPitchDeg = wakeOpenOrientation?.pitchDeg ?? NaN;
        const wakeOpenPitchOk =
            !Number.isFinite(wakeOpenPitchDeg) ||
            Math.abs(wakeOpenPitchDeg) <= WAKE_OPEN_PITCH_ABS_MAX_DEG;
        const wakeOpenFaceOnMin = palmFacing
            ? WAKE_OPEN_FRONT_FACE_ON_MIN
            : WAKE_OPEN_BACK_FACE_ON_MIN;
        const wakeOpenWorldFaceOnMin = palmFacing
            ? WAKE_OPEN_FRONT_WORLD_FACE_ON_MIN
            : WAKE_OPEN_BACK_WORLD_FACE_ON_MIN;
        const wakeOpenPalmSpreadMin = palmFacing
            ? WAKE_OPEN_FRONT_PALM_SPREAD_MIN
            : WAKE_OPEN_BACK_PALM_SPREAD_MIN;
        const wakeOpenFingerFan = this._dist(g[8], g[20]) / palmSize;
        const wakeOpenPalmNormal = worldLm ? this._getPalmNormal(worldLm) : null;
        const wakeOpenFingerPlane = Math.max(
            this._fingerPlaneComponent(worldLm, wakeOpenPalmNormal, 5, 8),
            this._fingerPlaneComponent(worldLm, wakeOpenPalmNormal, 9, 12),
            this._fingerPlaneComponent(worldLm, wakeOpenPalmNormal, 13, 16),
            this._fingerPlaneComponent(worldLm, wakeOpenPalmNormal, 17, 20)
        );
        const wakeOpenStrongFaceOn =
            wakeOpenFaceOnScore >= WAKE_OPEN_STRONG_FACE_ON_MIN &&
            wakeOpenWorldFaceOnScore >= WAKE_OPEN_STRONG_WORLD_FACE_ON_MIN;
        const wakeOpenFingerPlaneMax = wakeOpenStrongFaceOn
            ? WAKE_OPEN_STRONG_FACE_ON_FINGER_PLANE_MAX
            : WAKE_OPEN_FINGER_PLANE_MAX;
        const indexScreenLength = this._dist(lm[5], lm[8]) / palmSize2D;
        const middleScreenLength = this._dist(lm[9], lm[12]) / palmSize2D;
        const ringScreenLength = this._dist(lm[13], lm[16]) / palmSize2D;
        const pinkyScreenLength = this._dist(lm[17], lm[20]) / palmSize2D;
        const wakeOpenLongFingerScreenLength = Math.min(indexScreenLength, middleScreenLength, ringScreenLength);
        const wakeOpenLongFingersExtended = index.extended && middle.extended && ring.extended;
        const wakeOpenPinkyOpen =
            pinky.extended ||
            (!pinky.curled && pinky.tipDist > 0.88 && pinky.straightness > 0.80);
        const wakeOpenFingersStraight =
            index.straightness > 0.92 &&
            middle.straightness > 0.92 &&
            ring.straightness > 0.92 &&
            pinky.straightness > 0.80;
        const wakeOpenThumbPalmTh = palmFacing ? 1.00 : 1.10;
        const wakeOpenThumbOpen =
            thumb.thumbIndexTipDist >= 0.62 &&
            (thumb.extendedAway || thumb.thumbPalmDist >= wakeOpenThumbPalmTh);
        const wakeOpenPalmOpen = avgTipDist > WAKE_OPEN_AVG_TIP_DIST_MIN;
        const wakeOpenEligible =
            wakeOpenLongFingersExtended &&
            wakeOpenPinkyOpen &&
            wakeOpenFingersStraight &&
            wakeOpenThumbOpen &&
            wakeOpenPalmOpen &&
            wakeOpenFingerFan > WAKE_OPEN_FINGER_FAN_MIN &&
            wakeOpenFaceOnScore >= wakeOpenFaceOnMin &&
            wakeOpenPalmSpread >= wakeOpenPalmSpreadMin &&
            wakeOpenWorldFaceOnScore >= wakeOpenWorldFaceOnMin &&
            wakeOpenPitchOk &&
            wakeOpenFingerPlane <= wakeOpenFingerPlaneMax;

        this._lastWakeOpenDebug = {
            eligible: wakeOpenEligible,
            palmFacing,
            faceOnScore: wakeOpenFaceOnScore,
            faceOnMin: wakeOpenFaceOnMin,
            worldFaceOnScore: wakeOpenWorldFaceOnScore,
            worldFaceOnMin: wakeOpenWorldFaceOnMin,
            rollDeg: wakeOpenOrientation?.rollDeg ?? NaN,
            yawDeg: wakeOpenOrientation?.yawDeg ?? NaN,
            pitchDeg: wakeOpenPitchDeg,
            pitchAbsMaxDeg: WAKE_OPEN_PITCH_ABS_MAX_DEG,
            pitchOk: wakeOpenPitchOk,
            faceDeg: wakeOpenOrientation?.faceDeg ?? NaN,
            orientationSource: wakeOpenOrientation?.source ?? 'none',
            palmSpreadRatio: wakeOpenPalmSpread,
            palmSpreadMin: wakeOpenPalmSpreadMin,
            fingerPlane: wakeOpenFingerPlane,
            fingerPlaneMax: wakeOpenFingerPlaneMax,
            fingerPlaneRelaxed: wakeOpenStrongFaceOn,
            fingerFan: wakeOpenFingerFan,
            longFingerScreenLength: wakeOpenLongFingerScreenLength,
            pinkyScreenLength,
            longFingersExtended: wakeOpenLongFingersExtended,
            pinkyOpen: wakeOpenPinkyOpen,
            fingersStraight: wakeOpenFingersStraight,
            thumbOpen: wakeOpenThumbOpen,
            thumbPalmMin: wakeOpenThumbPalmTh,
            palmOpen: wakeOpenPalmOpen,
        };

        this._lastOkDebug = {
            palmFacing,
            thumbIndexOkDist: thumb.thumbIndexOkDist,
            thumbIndexTipDist: thumb.thumbIndexTipDist,
            okPinch,
            normalOkPinch,
            relaxedBentIndexOkPinch,
            strongOkPinch,
            strongIndexOkPinch,
            indexExtendedOkPinch,
            indexExtended: index.extended,
            indexCurled: index.curled,
            indexStraightness: index.straightness,
            indexBentForOk: index.bentForOk,
            thumbFolded: thumb.folded,
            thumbExtendedAway: thumb.extendedAway,
            thumbPalmDist: thumb.thumbPalmDist,
            fourThumbTucked,
            middleExtended: middle.extended,
            ringExtended: ring.extended,
            pinkyExtended: pinky.extended,
            otherExtendedCount,
            failureReason: okFailureReason,
        };

        // 1) ok: 親指と人差し指で輪を作る + 他3指のうち少なくとも2本が伸びている
        //    index.curled ではなく !index.extended を使用: OK の輪では人差し指が
        //    親指側にカーブするが、掌中心には近づかないため curled 判定にならない
        //    斜め向きでは親指先と人差し指先が離れて推定されやすいため、指先側の線分距離も使う
        //    強い輪が見えている場合は、人差し指の extended ブレを許容するが、指先が離れすぎた形は除外する
        //    さらに index.extended でも、人差し指自体が曲がっている場合だけ OK とする
        if (okPinch && okIndexAllowed && otherExtendedCount >= 2) {
            return 'ok';
        }

        // 2) aloha: 親指 + 小指が伸び、人差し指・中指・薬指が畳まれている
        //    小指は短いため extended 判定が不安定 → !curled で緩和
        //    thumbsup/down より先に判定し、小指が伸びかけの状態をキャッチする
        if (!pinky.curled && !index.extended && middle.curled && ring.curled &&
            thumb.extendedAway && thumb.thumbIndexTipDist > 0.35) {
            return 'aloha';
        }

        // 3) rock 🤘: 人差し指 + 小指が伸び、中指・薬指が畳まれている
        //    小指は短指のため !curled で緩和（aloha と同流儀）
        //    aloha との分離は index.extended、OK との分離は thumbIndexTipDist
        if (index.extended && middle.curled && ring.curled && !pinky.curled &&
            thumb.thumbIndexTipDist > 0.35) {
            return 'rock';
        }

        // 4) thumbsup / thumbsdown: 親指が孤立 + 4本指が畳まれている
        //    pinky.curled を明示的にチェックしてアロハとの誤判定を防ぐ
        if (curledCount >= 3 && !index.extended && !middle.extended && pinky.curled && thumb.extendedAway) {
            if (thumb.aboveWrist) return 'thumbsup';
            if (thumb.belowWrist) return 'thumbsdown';
        }

        // 5) fist: 4本指が掌に収まっている + 親指が掌近傍
        //    curledCount >= 3 で1本曖昧でも許容、ただし extended は不可
        if (
            curledCount >= 3 &&
            !index.extended && !middle.extended && !ring.extended && !pinky.extended &&
            avgTipDist < 0.95 &&
            thumb.folded &&
            thumb.thumbIndexTipDist > 0.35
        ) {
            return 'fist';
        }

        // 6) point-left/right/up: 人差し指だけが十分に特定方向を向いている
        if (index.extended && middle.curled && ring.curled && pinky.curled &&
            thumb.thumbIndexTipDist > 0.35) {
            const direction = this._getPointDirection(lm, palmSize2D);
            if (direction) return direction;
        }

        // 7) three: 人差し指 + 中指 + 薬指が伸び、小指が畳まれている
        //    長指3本 extended + 小指 curled で peace/open と自然に分離
        //    OK との衝突は index.extended で自動排除
        if (index.extended && middle.extended && ring.extended && pinky.curled) {
            return 'three';
        }

        // 8) peace: 人差し指 + 中指が伸びている
        const indexMiddleSpread = this._dist(g[8], g[12]) / palmSize;
        if (index.extended && middle.extended && ring.curled && pinky.curled &&
            indexMiddleSpread > 0.35) {
            return 'peace';
        }

        // 9) four: 4本指が伸び、親指は掌にしっかり折りたたまれている
        //    指が揃ったパー寄りの手を避けるため、親指が人差し指側に寄りすぎていないことも見る
        if (index.extended && middle.extended && ring.extended && !pinky.curled &&
            fourThumbTucked) {
            return 'four';
        }

        // 10) open / open-palm: 指が広がっている
        //    OK との衝突を避けるため、親指と人差し指が十分離れているときのみ open にする
        //    OK の典型形は人差し指が曲がるため、長指3本の伸展を必須にする
        //    掌向きはウェイクサイン用に別サインとして返し、open 側は互換性のため残す
        if (
            index.extended && middle.extended && ring.extended &&
            extendedCount >= 3 &&
            avgTipDist > 1.05 &&
            thumb.thumbIndexTipDist >= 0.50
        ) {
            return palmFacing ? 'open-palm' : 'open';
        }

        return 'unknown';
    }
}
