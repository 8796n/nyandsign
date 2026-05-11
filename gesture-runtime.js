/* ============================================================
 * ジェスチャー実行ランタイム共通部
 *
 * sidepanel.js / pip.js で共有する、両手サイン判定・方向スクロール制御・
 * 操作モード補助・ポインタ表示維持。
 * UI 構築・通知音・ストレージ保存は呼び出し側に残す。
 * ============================================================ */

const META_GESTURE_DISPLAY = {
    frame: { emoji: '🖼️', i18nKey: 'metaGestureFrame' },
    'both-peace': { emoji: '✌️✌️', i18nKey: 'metaGestureBothPeace' },
    'peace-fist': { emoji: '✌️✊', i18nKey: 'metaGesturePeaceFist' },
};

function metaGestureLabel(type) {
    const disp = META_GESTURE_DISPLAY[type];
    return disp ? `${disp.emoji} ${msg(disp.i18nKey)}` : type;
}

const GestureRuntimeUtils = {
    isPointerModeAvailable(enabled) {
        return enabled === true;
    },

    normalizeOperationMode(mode, pointerEnabled) {
        if (mode === OPERATION_MODES.POINTER) {
            return this.isPointerModeAvailable(pointerEnabled)
                ? OPERATION_MODES.POINTER
                : OPERATION_MODES.BROWSER;
        }
        if (mode === OPERATION_MODES.BROWSER) return OPERATION_MODES.BROWSER;
        return OPERATION_MODES.MEDIA;
    },

    availableOperationModes(pointerEnabled) {
        return OPERATION_MODE_ORDER.filter(mode =>
            mode !== OPERATION_MODES.POINTER || this.isPointerModeAvailable(pointerEnabled)
        );
    },

    modeBeepFrequency(mode) {
        if (mode === OPERATION_MODES.BROWSER) return 660;
        if (mode === OPERATION_MODES.POINTER) return 740;
        return 880;
    },

    modeLabel(mode) {
        if (mode === OPERATION_MODES.BROWSER) return msg('operationModeBrowser');
        if (mode === OPERATION_MODES.POINTER) return msg('operationModePointer');
        return msg('operationModeMedia');
    },

    enabledMetaAction(action, pointerEnabled) {
        if (action === 'setModePointer' && !this.isPointerModeAvailable(pointerEnabled)) return 'none';
        return action || 'none';
    },

    dist2d(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    },

    handPosition(hand) {
        if (!hand?.landmarks) return null;
        const lm = hand.landmarks;
        const points = [lm[0], lm[5], lm[9], lm[13], lm[17]].filter(Boolean);
        if (!points.length) return null;
        const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
        return { x: sum.x / points.length, y: sum.y / points.length };
    },

    findHandForGesture(gesture, hands = [], preferredHand = 'auto') {
        const candidates = hands.filter(h => h.gesture === gesture);
        if (!candidates.length) return null;
        if (preferredHand !== 'auto') {
            return candidates.find(h => h.hand === preferredHand) || candidates[0];
        }
        return candidates[0];
    },

    isDistinctHandPair(handA, handB) {
        if (!handA?.landmarks || !handB?.landmarks) return false;

        const lmA = handA.landmarks;
        const lmB = handB.landmarks;
        const psA = this.dist2d(lmA[0], lmA[9]);
        const psB = this.dist2d(lmB[0], lmB[9]);
        const avgPs = (psA + psB) / 2;
        const wristDistance = this.dist2d(lmA[0], lmB[0]);

        // 同一の実手を2件として検出した場合は手首位置がかなり近い。
        if (wristDistance < avgPs * 0.9) return false;

        // handedness が同じで距離も近い場合は、重複検出の可能性が高い。
        if (handA.hand !== 'unknown' && handB.hand !== 'unknown' &&
            handA.hand === handB.hand && wristDistance < avgPs * 1.6) {
            return false;
        }

        return true;
    },

    distinctHandPairs(hands = []) {
        const pairs = [];
        for (let i = 0; i < hands.length; i++) {
            for (let j = i + 1; j < hands.length; j++) {
                if (this.isDistinctHandPair(hands[i], hands[j])) pairs.push([hands[i], hands[j]]);
            }
        }
        return pairs;
    },

    detectFrameGesture(pairs) {
        for (const [handA, handB] of pairs) {
            const lm1 = handA.landmarks;
            const lm2 = handB.landmarks;

            const ps1 = this.dist2d(lm1[0], lm1[9]);
            const ps2 = this.dist2d(lm2[0], lm2[9]);
            const avgPs = (ps1 + ps2) / 2;
            const threshold = avgPs * 0.5;

            const d1 = this.dist2d(lm1[4], lm2[8]);
            const d2 = this.dist2d(lm1[8], lm2[4]);

            if (d1 < threshold && d2 < threshold) {
                const cy1 = (lm1[4].y + lm2[8].y) / 2;
                const cy2 = (lm1[8].y + lm2[4].y) / 2;
                if (Math.abs(cy1 - cy2) > avgPs * 0.3) return true;
            }
        }
        return false;
    },

    detectMetaGestureType(hands = []) {
        const pairs = this.distinctHandPairs(hands);
        if (!pairs.length) return null;
        if (this.detectFrameGesture(pairs)) return 'frame';
        if (pairs.some(([a, b]) => a.gesture === 'peace' && b.gesture === 'peace')) return 'both-peace';
        if (pairs.some(([a, b]) =>
            (a.gesture === 'peace' && b.gesture === 'fist') ||
            (a.gesture === 'fist' && b.gesture === 'peace'))) return 'peace-fist';
        return null;
    },

    directionalAmount(delta, deadzone = 0.045, maxOffset = 0.28, maxPixels = 180) {
        const sign = Math.sign(delta);
        const distance = Math.abs(delta);
        if (distance <= deadzone) return 0;
        const ratio = Math.min(1, (distance - deadzone) / (maxOffset - deadzone));
        return Math.round(sign * ratio * maxPixels);
    },
};

class ContinuousGestureGate {
    constructor() {
        this.gesture = null;
        this.releaseRequired = false;
    }

    get active() { return this.gesture !== null; }

    start(gesture) {
        this.gesture = gesture || null;
        this.releaseRequired = false;
    }

    stop(options = {}) {
        this.gesture = null;
        if (options.requireRelease) this.releaseRequired = true;
    }

    reset() {
        this.gesture = null;
        this.releaseRequired = false;
    }

    handleGestureChange(gesture, isWakeGesture = () => false) {
        if (!gesture) {
            this.reset();
            return { allowAction: true };
        }

        if (isWakeGesture(gesture)) {
            this.reset();
            return { allowAction: true };
        }

        if (this.releaseRequired) {
            return { allowAction: false, interrupted: false };
        }

        if (this.gesture && gesture !== this.gesture) {
            const previousGesture = this.gesture;
            this.stop({ requireRelease: true });
            return { allowAction: false, interrupted: true, previousGesture };
        }

        return { allowAction: true };
    }
}

class DirectionalScrollController {
    constructor(options) {
        this.tracker = options.tracker;
        this.sendAction = options.sendAction;
        this.extendWakeTimeout = options.extendWakeTimeout;
        this.stopAllGestureActions = options.stopAllGestureActions;
        this.isControlEnabled = options.isControlEnabled;
        this.intervalMs = options.intervalMs ?? 80;
        this.deadzone = options.deadzone ?? 0.045;
        this.maxOffset = options.maxOffset ?? 0.28;
        this.maxPixels = options.maxPixels ?? 180;
        this.graceMs = options.graceMs ?? 250;
        this.maxTrackingJump = options.maxTrackingJump ?? 0.18;
        this.state = null;
    }

    get active() { return this.state !== null; }

    start(gesture, hands = [], now = Date.now()) {
        const hand = GestureRuntimeUtils.findHandForGesture(gesture, hands, this.tracker.preferredHand);
        const origin = GestureRuntimeUtils.handPosition(hand);
        if (!origin) return false;
        this.state = {
            gesture,
            hand: hand?.hand || 'unknown',
            origin,
            lastPosition: origin,
            lastSeenAt: now,
            lastSentAt: 0,
        };
        return true;
    }

    stop() {
        this.state = null;
    }

    findTrackedHand(hands = []) {
        if (!this.state?.lastPosition) return null;

        const byHand = this.state.hand && this.state.hand !== 'unknown'
            ? hands.filter(h => h.hand === this.state.hand)
            : [];
        const candidates = byHand.length ? byHand : hands;
        let best = null;
        let bestDistance = Infinity;

        for (const hand of candidates) {
            const pos = GestureRuntimeUtils.handPosition(hand);
            if (!pos) continue;
            const distance = GestureRuntimeUtils.dist2d(pos, this.state.lastPosition);
            if (distance < bestDistance) {
                best = { hand, pos };
                bestDistance = distance;
            }
        }

        return bestDistance <= this.maxTrackingJump ? best : null;
    }

    update(hands = [], now) {
        if (!this.state || !this.isControlEnabled()) return;

        const hand = GestureRuntimeUtils.findHandForGesture(
            this.state.gesture,
            hands,
            this.tracker.preferredHand
        );
        let pos = GestureRuntimeUtils.handPosition(hand);

        if (pos) {
            this.state.hand = hand?.hand || this.state.hand;
            this.state.lastPosition = pos;
            this.state.lastSeenAt = now;
        } else {
            const withinGrace = now - this.state.lastSeenAt <= this.graceMs;
            const tracked = withinGrace ? this.findTrackedHand(hands) : null;
            if (tracked?.pos) {
                pos = tracked.pos;
                this.state.lastPosition = pos;
            } else if (withinGrace) {
                return;
            }
        }

        if (!pos) {
            this.stopAllGestureActions();
            return;
        }

        if (now - this.state.lastSentAt < this.intervalMs) return;

        let dx = pos.x - this.state.origin.x;
        const dy = pos.y - this.state.origin.y;
        if (this.tracker.displayMirrored) dx = -dx;

        const left = GestureRuntimeUtils.directionalAmount(dx, this.deadzone, this.maxOffset, this.maxPixels);
        const top = GestureRuntimeUtils.directionalAmount(dy, this.deadzone, this.maxOffset, this.maxPixels);
        if (!left && !top) return;

        this.state.lastSentAt = now;
        this.sendAction('directionalScroll', { left, top });
        this.extendWakeTimeout();
    }
}

class PointerMoveController {
    constructor(options) {
        this.tracker = options.tracker;
        this.sendAction = options.sendAction;
        this.extendWakeTimeout = options.extendWakeTimeout;
        this.stopAllGestureActions = options.stopAllGestureActions;
        this.isControlEnabled = options.isControlEnabled;
        this.intervalMs = options.intervalMs ?? 32;
        this.deadzone = options.deadzone ?? 0.025;
        this.maxOffset = options.maxOffset ?? 0.22;
        this.maxPixels = options.maxPixels ?? 26;
        this.graceMs = options.graceMs ?? 250;
        this.maxTrackingJump = options.maxTrackingJump ?? 0.18;
        this.state = null;
    }

    get active() { return this.state !== null; }

    start(gesture, hands = [], now = Date.now()) {
        const hand = GestureRuntimeUtils.findHandForGesture(gesture, hands, this.tracker.preferredHand);
        const origin = GestureRuntimeUtils.handPosition(hand);
        if (!origin) return false;
        this.state = {
            gesture,
            hand: hand?.hand || 'unknown',
            origin,
            lastPosition: origin,
            lastSeenAt: now,
            lastSentAt: 0,
        };
        this.sendAction('pointerMoveStart');
        return true;
    }

    stop() {
        if (!this.state) return;
        this.state = null;
        this.sendAction('pointerMoveEnd');
    }

    findTrackedHand(hands = []) {
        if (!this.state?.lastPosition) return null;

        const byHand = this.state.hand && this.state.hand !== 'unknown'
            ? hands.filter(h => h.hand === this.state.hand)
            : [];
        const candidates = byHand.length ? byHand : hands;
        let best = null;
        let bestDistance = Infinity;

        for (const hand of candidates) {
            const pos = GestureRuntimeUtils.handPosition(hand);
            if (!pos) continue;
            const distance = GestureRuntimeUtils.dist2d(pos, this.state.lastPosition);
            if (distance < bestDistance) {
                best = { hand, pos };
                bestDistance = distance;
            }
        }

        return bestDistance <= this.maxTrackingJump ? best : null;
    }

    update(hands = [], now) {
        if (!this.state || !this.isControlEnabled()) return;

        const hand = GestureRuntimeUtils.findHandForGesture(
            this.state.gesture,
            hands,
            this.tracker.preferredHand
        );
        let pos = GestureRuntimeUtils.handPosition(hand);

        if (pos) {
            this.state.hand = hand?.hand || this.state.hand;
            this.state.lastPosition = pos;
            this.state.lastSeenAt = now;
        } else {
            const withinGrace = now - this.state.lastSeenAt <= this.graceMs;
            const tracked = withinGrace ? this.findTrackedHand(hands) : null;
            if (tracked?.pos) {
                pos = tracked.pos;
                this.state.lastPosition = pos;
            } else if (withinGrace) {
                return;
            }
        }

        if (!pos) {
            this.stopAllGestureActions();
            return;
        }

        if (now - this.state.lastSentAt < this.intervalMs) return;

        let dx = pos.x - this.state.origin.x;
        const dy = pos.y - this.state.origin.y;
        if (this.tracker.displayMirrored) dx = -dx;

        const left = GestureRuntimeUtils.directionalAmount(dx, this.deadzone, this.maxOffset, this.maxPixels);
        const top = GestureRuntimeUtils.directionalAmount(dy, this.deadzone, this.maxOffset, this.maxPixels);
        if (!left && !top) return;

        this.state.lastSentAt = now;
        this.sendAction('pointerMove', { left, top });
        this.extendWakeTimeout();
    }
}

class MetaGestureController {
    constructor(options) {
        this.getMetaAction = options.getMetaAction;
        this.getHoldMs = options.getHoldMs;
        this.executeMetaAction = options.executeMetaAction;
        this.onActiveStart = options.onActiveStart ?? (() => {});
        this.onDisplay = options.onDisplay ?? (() => {});
        this.onExecuted = options.onExecuted ?? (() => {});
        this.cooldownMs = options.cooldownMs ?? 2000;
        this.graceMs = options.graceMs ?? 150;
        this.active = false;
        this.startTime = 0;
        this.consumed = false;
        this.lastSeen = 0;
        this.lastExecutedAt = 0;
    }

    reset() {
        this.active = false;
        this.startTime = 0;
        this.consumed = false;
        this.lastSeen = 0;
    }

    isBlocking() {
        return this.active || this.consumed;
    }

    update(hands = [], now) {
        const detectedType = GestureRuntimeUtils.detectMetaGestureType(hands);

        if (detectedType) {
            this.lastSeen = now;
        } else if (this.consumed && now - this.lastSeen > this.graceMs) {
            this.consumed = false;
        }

        if (this.consumed) {
            this.active = false;
            return { allowDirectional: false };
        }

        if (now - this.lastExecutedAt < this.cooldownMs) {
            if (detectedType) {
                this.active = true;
                this.startTime = now;
            } else {
                this.active = false;
                this.startTime = 0;
            }
            return { allowDirectional: !this.active };
        }

        const metaAction = detectedType ? this.getMetaAction(detectedType) : 'none';
        const detected = detectedType && metaAction && metaAction !== 'none';

        if (detected) {
            if (!this.active) {
                this.active = true;
                this.startTime = now;
                this.lastSeen = now;
                this.onActiveStart(detectedType, metaAction);
            }
            this.lastSeen = now;
            this.onDisplay(detectedType, metaAction);

            if (now - this.startTime >= this.getHoldMs()) {
                if (this.executeMetaAction(detectedType, metaAction)) {
                    this.lastExecutedAt = now;
                    this.consumed = true;
                    this.lastSeen = now;
                    this.onExecuted(detectedType, metaAction);
                }
                this.active = false;
                this.startTime = 0;
            }
            return { allowDirectional: false };
        }

        if (this.active && now - this.lastSeen > this.graceMs) {
            this.active = false;
            this.startTime = 0;
        }

        return { allowDirectional: !this.active };
    }
}

class PointerVisibilityController {
    constructor(options) {
        this.getOperationMode = options.getOperationMode;
        this.isControlEnabled = options.isControlEnabled;
        this.hasCameraStream = options.hasCameraStream;
        this.sendAction = options.sendAction;
        this.intervalMs = options.intervalMs ?? 2000;
        this.timer = null;
    }

    shouldKeepVisible() {
        return this.getOperationMode() === OPERATION_MODES.POINTER &&
            this.isControlEnabled() &&
            this.hasCameraStream();
    }

    stop(options = {}) {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (options.hide) this.sendAction('pointerHide');
    }

    start() {
        if (!this.shouldKeepVisible()) return;
        if (!this.timer) {
            this.timer = setInterval(() => {
                if (this.shouldKeepVisible()) {
                    this.sendAction('pointerShow');
                } else {
                    this.stop({ hide: true });
                }
            }, this.intervalMs);
        }
        this.sendAction('pointerShow');
    }

    sync(previousMode = this.getOperationMode()) {
        if (previousMode === OPERATION_MODES.POINTER &&
            this.getOperationMode() !== OPERATION_MODES.POINTER) {
            this.stop({ hide: true });
            return;
        }
        if (this.shouldKeepVisible()) {
            this.start();
        } else {
            this.stop({ hide: true });
        }
    }
}
