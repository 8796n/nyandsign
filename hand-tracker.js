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

        // --- サイン安定化: 時間窓ベース多数決 + 切替ヒステリシス ---
        // サンプルはタイムスタンプ付きで保持し、時間窓内のみ集計
        this._gestureSamples = [];         // [{ gesture, time }]
        this._stabilizeWindowMs = 200;     // 多数決の時間窓 (ms)
        this._stableGesture = null;
        this._candidateGesture = null;
        this._candidateStartTime = 0;      // 候補の初出タイムスタンプ
        this._switchDwellMs = 100;         // 切替確定に必要な持続時間 (ms)

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
        const result = this.handLandmarker.detectForVideo(video, now);
        this._lastResult = result;

        if (!result || !result.landmarks || result.landmarks.length === 0) {
            this._lastHandData = [];
            this._updateGesture(null, now);
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
            hands.push({ hand, gesture, landmarks: lm, idx: i });
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
        // もう片方の手の point-left/right を受け付ける
        const COMMAND_GESTURES = ['ok', 'fist', 'thumbsup', 'thumbsdown', 'peace', 'aloha', 'point-left', 'point-right', 'open'];
        if (!COMMAND_GESTURES.includes(activeGesture)) {
            for (const g of hands) {
                if (g.idx !== activeIdx && (g.gesture === 'point-left' || g.gesture === 'point-right')) {
                    activeGesture = g.gesture;
                    break;
                }
            }
        }

        // 主手の手首座標を記録（手の追跡用）
        const wristIdx = activeIdx >= 0 ? activeIdx : 0;
        if (wristIdx < result.landmarks.length) {
            const wrist = result.landmarks[wristIdx][0];
            this._trackedWrist = { x: wrist.x, y: wrist.y };
        }

        this._updateGesture(activeGesture, now);

        // 詳細イベント
        this.dispatchEvent(new CustomEvent('frame', {
            detail: { gestures: hands, handCount: result.landmarks.length }
        }));
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
    _updateGesture(gesture, now) {
        // null（手なし）: 即座に安定サインをクリアしてイベント発火
        // サンプル・候補は安定状態に関係なく常にクリアする（再出現時の誤判定防止）
        if (gesture === null) {
            this._gestureSamples = [];
            this._candidateGesture = null;
            this._candidateStartTime = 0;
            if (this._stableGesture !== null) {
                this._stableGesture = null;
                this.dispatchEvent(new CustomEvent('gesture', {
                    detail: { gesture: null }
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
                detail: { gesture: winner }
            }));
        }
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

    _vecLen(v) {
        return Math.sqrt(v.x * v.x + v.y * v.y + (v.z ?? 0) * (v.z ?? 0));
    }

    _normalize(v) {
        const n = this._vecLen(v);
        if (n < 1e-6) return { x: 0, y: 0, z: 0 };
        return { x: v.x / n, y: v.y / n, z: (v.z ?? 0) / n };
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
    _getFingerState(g, palmCenter, palmSize, u, _mcp, pip, tip, palmFacing) {
        const tipDist = this._dist(g[tip], palmCenter) / palmSize;
        const pipDist = this._dist(g[pip], palmCenter) / palmSize;
        const tipAlong = this._dot(this._sub(g[tip], palmCenter), u) / palmSize;
        const pipAlong = this._dot(this._sub(g[pip], palmCenter), u) / palmSize;

        // 手の甲向き: 自己遮蔽でランドマークがブレるため閾値を緩和
        const curledTipTh  = palmFacing ? 0.95 : 1.05;
        const curledAlongM = palmFacing ? 0.05 : 0.10;
        const extTipTh     = palmFacing ? 1.05 : 0.95;
        const extAlongM    = palmFacing ? 0.08 : 0.05;

        const curled   = tipDist < curledTipTh && tipAlong < pipAlong + curledAlongM;
        const extended = tipDist > extTipTh    && tipAlong > pipAlong + extAlongM;

        return { tipDist, curled, extended };
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

        return { thumbPalmDist, thumbIndexTipDist, folded, extendedAway, aboveWrist, belowWrist };
    }

    /**
     * 人差し指の向きから左右ポイントを判定する。
     * 画面座標を palmSize2D で正規化し、横向きが十分強い場合のみ左右を返す。
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
     * 判定順: ok → aloha → rock → thumbsup/down → fist → point-left/right → three → peace → four → open
     * 距離は palmSize で正規化 → カメラ距離・手の大きさに非依存
     * ============================================================ */

    _detectGesture(lm, handedness, worldLm = null) {
        const palm = this._getPalmGeometry(lm, worldLm, handedness);
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

        // 1) ok: 親指と人差し指で輪を作る + 他3指のうち少なくとも2本が伸びている
        //    index.curled ではなく !index.extended を使用: OK の輪では人差し指が
        //    親指側にカーブするが、掌中心には近づかないため curled 判定にならない
        if (thumb.thumbIndexTipDist < 0.50 && !index.extended && otherExtendedCount >= 2) {
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

        // 6) point-left/right: 人差し指が横を向いている
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

        // 9) four: 4本指が伸び、親指は掌に折りたたまれている
        //    open との分離は thumb.folded、three との分離は !pinky.curled
        if (index.extended && middle.extended && ring.extended && !pinky.curled &&
            thumb.folded) {
            return 'four';
        }

        // 10) open: 指が広がっている
        //    OK との衝突を避けるため、親指と人差し指が十分離れているときのみ open にする
        if (extendedCount >= 3 && avgTipDist > 1.05 && thumb.thumbIndexTipDist >= 0.50) {
            return 'open';
        }

        return 'unknown';
    }
}
