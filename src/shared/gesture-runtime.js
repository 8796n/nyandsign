/* ============================================================
 * ジェスチャー実行ランタイム共通部
 *
 * sidepanel.js / pip.js で共有する、両手サイン判定・方向スクロール制御・
 * 操作モード補助・ポインタ表示維持。
 * UI 構築・通知音・ストレージ保存は呼び出し側に残す。
 * ============================================================ */

const META_GESTURE_DISPLAY = {
    frame: { emoji: '🖼️', i18nKey: 'metaGestureFrame' },
    'both-open': { emoji: '🖐️🖐️', i18nKey: 'metaGestureBothOpen' },
    'both-peace': { emoji: '✌️✌️', i18nKey: 'metaGestureBothPeace' },
    'peace-fist': { emoji: '✌️✊', i18nKey: 'metaGesturePeaceFist' },
};

function metaGestureLabel(type) {
    const disp = META_GESTURE_DISPLAY[type];
    return disp ? `${disp.emoji} ${msg(disp.i18nKey)}` : type;
}

const GestureRuntimeUtils = {
    normalizeOperationMode(mode) {
        if (mode === OPERATION_MODES.POINTER) return OPERATION_MODES.POINTER;
        if (mode === OPERATION_MODES.BROWSER) return OPERATION_MODES.BROWSER;
        return OPERATION_MODES.MEDIA;
    },

    availableOperationModes() {
        return OPERATION_MODE_ORDER;
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

    enabledMetaAction(action) {
        return action || 'none';
    },

    isUncertainGesture(gesture) {
        return !gesture || gesture === 'unknown';
    },

    isOpenGesture(gesture) {
        return gesture === 'open' || gesture === 'open-palm';
    },

    findOpenHand(gesture, hands = [], activeIdx = null) {
        if (!this.isOpenGesture(gesture) || !Array.isArray(hands) || !hands.length) return null;

        const activeHand = Number.isInteger(activeIdx)
            ? hands.find(h => h?.idx === activeIdx) || hands[activeIdx]
            : null;
        if (this.isOpenGesture(activeHand?.gesture)) return activeHand;

        return hands.find(h => this.isOpenGesture(h?.gesture)) || null;
    },

    findWakeOpenHand(gesture, hands = [], activeIdx = null) {
        const hand = this.findOpenHand(gesture, hands, activeIdx);
        if (hand?.wakeOpen === true) return hand;
        return null;
    },

    isWakeGesture(gesture, wakeGestureType, hands = [], activeIdx = null) {
        if (wakeGestureType === 'open') {
            return this.findWakeOpenHand(gesture, hands, activeIdx) !== null;
        }
        if (wakeGestureType === 'open-palm') {
            const hand = this.findWakeOpenHand(gesture, hands, activeIdx);
            return gesture === 'open-palm' && hand?.gesture === 'open-palm';
        }
        return gesture === wakeGestureType;
    },

    wakeOpenFaceOnMin(debug = {}) {
        return debug.faceOnMin ?? (debug.palmFacing === false
            ? WAKE_OPEN_BACK_FACE_ON_MIN
            : WAKE_OPEN_FRONT_FACE_ON_MIN);
    },

    wakeOpenPalmSpreadMin(debug = {}) {
        return debug.palmSpreadMin ?? (debug.palmFacing === false
            ? WAKE_OPEN_BACK_PALM_SPREAD_MIN
            : WAKE_OPEN_FRONT_PALM_SPREAD_MIN);
    },

    wakeOpenIssueIds(gesture, wakeGestureType, hands = [], activeIdx = null) {
        if (wakeGestureType !== 'open' && wakeGestureType !== 'open-palm') return [];
        const hand = this.findOpenHand(gesture, hands, activeIdx);
        if (!hand) return [];

        const issues = [];
        const debug = hand.wakeOpenDebug || {};

        if (wakeGestureType === 'open-palm' && hand.gesture !== 'open-palm') issues.push('palmSide');
        const angleTooShallow =
            debug.faceOnScore < this.wakeOpenFaceOnMin(debug) ||
            debug.palmSpreadRatio < this.wakeOpenPalmSpreadMin(debug) ||
            debug.worldFaceOnScore < (debug.worldFaceOnMin ?? 0);
        if (angleTooShallow) return ['faceOn'];

        if (debug.longFingersExtended === false) issues.push('fingersExtended');
        if (debug.longFingersExtended !== false && debug.pinkyOpen === false) issues.push('pinkyOpen');
        if (debug.fingerPlane > (debug.fingerPlaneMax ?? WAKE_OPEN_FINGER_PLANE_MAX)) issues.push('fingerDepth');
        if (debug.longFingersExtended !== false && debug.pinkyOpen !== false && debug.fingersStraight === false) {
            issues.push('fingersStraight');
        }
        if (debug.thumbOpen === false) issues.push('thumbOpen');
        if (debug.palmOpen === false) issues.push('palmOpen');
        if (debug.fingerFan < WAKE_OPEN_FINGER_FAN_MIN) issues.push('fingerFan');

        return issues;
    },

    wakeOpenIssueText(issueIds = [], limit = 2) {
        const labels = issueIds
            .slice(0, limit)
            .map(id => msg(WAKE_OPEN_ISSUE_I18N_KEYS[id] || 'wakeOpenIssueUnknown'))
            .filter(Boolean);
        if (!labels.length) return '';
        return msg('wakeOpenNeeds', [labels.join(msg('wakeOpenIssueSeparator'))]);
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
        if (pairs.some(([a, b]) => this.isOpenGesture(a.gesture) && this.isOpenGesture(b.gesture))) return 'both-open';
        if (pairs.some(([a, b]) => a.gesture === 'peace' && b.gesture === 'peace')) return 'both-peace';
        if (pairs.some(([a, b]) =>
            (a.gesture === 'peace' && b.gesture === 'fist') ||
            (a.gesture === 'fist' && b.gesture === 'peace'))) return 'peace-fist';
        return null;
    },

    directionalAmount(delta, deadzone = 0.045, maxOffset = 0.28, maxPixels = 180, curvePower = 1) {
        const sign = Math.sign(delta);
        const distance = Math.abs(delta);
        if (distance <= deadzone) return 0;
        const range = Math.max(0.0001, maxOffset - deadzone);
        const ratio = Math.min(1, (distance - deadzone) / range);
        const power = Number.isFinite(curvePower) && curvePower > 0 ? curvePower : 1;
        const curvedRatio = power === 1 ? ratio : Math.pow(ratio, power);
        return Math.round(sign * curvedRatio * maxPixels);
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
        this.getSpeedMultiplier = options.getSpeedMultiplier ?? (() => 1);
        this.curvePower = options.curvePower ?? 1;
        this.graceMs = options.graceMs ?? 250;
        this.resumeWindowMs = options.resumeWindowMs ?? HOLD_GESTURE_RESUME_WINDOW_MS;
        this.maxTrackingJump = options.maxTrackingJump ?? 0.18;
        this.state = null;
    }

    get active() { return this.state?.phase === 'active'; }
    get suspended() { return this.state?.phase === 'suspended'; }

    start(gesture, hands = [], now = Date.now()) {
        const hand = GestureRuntimeUtils.findHandForGesture(gesture, hands, this.tracker.preferredHand);
        const origin = GestureRuntimeUtils.handPosition(hand);
        if (!origin) return false;
        this.state = {
            phase: 'active',
            gesture,
            hand: hand?.hand || 'unknown',
            origin,
            lastPosition: origin,
            lastSeenAt: now,
            lastSentAt: 0,
            suspendedAt: 0,
        };
        return true;
    }

    stop() {
        this.state = null;
    }

    suspend(now = Date.now()) {
        if (!this.active) return false;
        this.state.phase = 'suspended';
        this.state.suspendedAt = now;
        return true;
    }

    canResume(gesture, now = Date.now()) {
        return this.suspended &&
            this.state.gesture === gesture &&
            now - this.state.suspendedAt <= this.resumeWindowMs;
    }

    resume(gesture, hands = [], now = Date.now()) {
        if (!this.canResume(gesture, now)) return false;
        const hand = GestureRuntimeUtils.findHandForGesture(gesture, hands, this.tracker.preferredHand);
        const pos = GestureRuntimeUtils.handPosition(hand);
        if (!pos) return false;
        this.state.phase = 'active';
        this.state.hand = hand?.hand || this.state.hand;
        this.state.lastPosition = pos;
        this.state.lastSeenAt = now;
        this.state.lastSentAt = 0;
        this.state.suspendedAt = 0;
        return true;
    }

    expireSuspension(now = Date.now()) {
        if (!this.suspended || now - this.state.suspendedAt <= this.resumeWindowMs) return false;
        this.stop();
        return true;
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
        if (this.suspended) {
            if (now - this.state.suspendedAt > this.resumeWindowMs) this.stopAllGestureActions();
            return;
        }

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
            this.suspend(now);
            return;
        }

        if (now - this.state.lastSentAt < this.intervalMs) return;

        let dx = pos.x - this.state.origin.x;
        const dy = pos.y - this.state.origin.y;
        if (this.tracker.displayMirrored) dx = -dx;

        const maxPixels = this.maxPixels * (Number(this.getSpeedMultiplier()) || 1);
        const left = GestureRuntimeUtils.directionalAmount(dx, this.deadzone, this.maxOffset, maxPixels, this.curvePower);
        const top = GestureRuntimeUtils.directionalAmount(dy, this.deadzone, this.maxOffset, maxPixels, this.curvePower);
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
        this.canResumeGesture = options.canResumeGesture ?? ((previousGesture, nextGesture) => previousGesture === nextGesture);
        this.onStateChange = options.onStateChange ?? (() => {});
        this.intervalMs = options.intervalMs ?? 32;
        this.deadzone = options.deadzone ?? 0.022;
        this.maxOffset = options.maxOffset ?? 0.2;
        this.maxPixels = options.maxPixels ?? 34;
        this.getSpeedMultiplier = options.getSpeedMultiplier ?? (() => 1);
        this.curvePower = options.curvePower ?? 1.25;
        this.graceMs = options.graceMs ?? 250;
        this.resumeWindowMs = options.resumeWindowMs ?? HOLD_GESTURE_RESUME_WINDOW_MS;
        this.maxTrackingJump = options.maxTrackingJump ?? 0.18;
        this.state = null;
    }

    get active() { return this.state?.phase === 'active'; }
    get suspended() { return this.state?.phase === 'suspended'; }

    isPointGesture(gesture) {
        return gesture === 'point-left' || gesture === 'point-right' || gesture === 'point-up';
    }

    landmarkPoint(point) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        return { x: point.x, y: point.y };
    }

    closestPointOnSegment(point, a, b) {
        const p = this.landmarkPoint(point);
        const start = this.landmarkPoint(a);
        const end = this.landmarkPoint(b);
        if (!p || !start || !end) return null;

        const abx = end.x - start.x;
        const aby = end.y - start.y;
        const denom = abx * abx + aby * aby;
        if (denom < 1e-8) return start;

        const t = Math.max(0, Math.min(1, ((p.x - start.x) * abx + (p.y - start.y) * aby) / denom));
        return {
            x: start.x + abx * t,
            y: start.y + aby * t,
        };
    }

    okPinchPosition(hand) {
        const lm = hand?.landmarks;
        const thumbTip = this.landmarkPoint(lm?.[4]);
        if (!thumbTip) return null;

        const candidates = [
            this.closestPointOnSegment(thumbTip, lm?.[6], lm?.[7]),
            this.closestPointOnSegment(thumbTip, lm?.[7], lm?.[8]),
        ].filter(Boolean);
        if (!candidates.length) return null;

        const indexPoint = candidates.reduce((best, point) =>
            GestureRuntimeUtils.dist2d(thumbTip, point) < GestureRuntimeUtils.dist2d(thumbTip, best)
                ? point
                : best
        );

        return {
            x: (thumbTip.x + indexPoint.x) / 2,
            y: (thumbTip.y + indexPoint.y) / 2,
        };
    }

    pointerPosition(hand, gesture) {
        if (this.isPointGesture(gesture)) {
            return this.landmarkPoint(hand?.landmarks?.[8]) || GestureRuntimeUtils.handPosition(hand);
        }
        if (gesture === 'ok') {
            return this.okPinchPosition(hand) || GestureRuntimeUtils.handPosition(hand);
        }
        return GestureRuntimeUtils.handPosition(hand);
    }

    start(gesture, hands = [], now = Date.now()) {
        const hand = GestureRuntimeUtils.findHandForGesture(gesture, hands, this.tracker.preferredHand);
        const origin = this.pointerPosition(hand, gesture);
        if (!origin) return false;
        this.state = {
            phase: 'active',
            gesture,
            hand: hand?.hand || 'unknown',
            origin,
            lastPosition: origin,
            lastSeenAt: now,
            lastSentAt: 0,
            suspendedAt: 0,
            skipNextUpdate: false,
        };
        this.sendAction('pointerMoveStart');
        this.onStateChange(this.state);
        return true;
    }

    switchGesture(gesture, hands = [], now = Date.now()) {
        if (!this.active || !gesture || gesture === this.state.gesture) return false;
        const hand = GestureRuntimeUtils.findHandForGesture(gesture, hands, this.tracker.preferredHand);
        const pos = this.pointerPosition(hand, gesture);
        if (!pos) return false;

        const previousGesture = this.state.gesture;
        const keepOrigin = this.isPointGesture(previousGesture) && this.isPointGesture(gesture);
        if (!keepOrigin) {
            const dx = this.state.lastPosition.x - this.state.origin.x;
            const dy = this.state.lastPosition.y - this.state.origin.y;
            this.state.origin = { x: pos.x - dx, y: pos.y - dy };
        }

        this.state.gesture = gesture;
        this.state.hand = hand?.hand || this.state.hand;
        this.state.lastPosition = pos;
        this.state.lastSeenAt = now;
        this.state.lastSentAt = now;
        this.state.skipNextUpdate = false;
        this.extendWakeTimeout();
        this.onStateChange(this.state);
        return true;
    }

    stop() {
        if (!this.state) return;
        const wasActive = this.active;
        this.state = null;
        if (wasActive) this.sendAction('pointerMoveEnd');
        this.onStateChange(null);
    }

    suspend(now = Date.now()) {
        if (!this.active) return false;
        this.state.phase = 'suspended';
        this.state.suspendedAt = now;
        this.sendAction('pointerMoveEnd');
        this.onStateChange(this.state);
        return true;
    }

    canResume(gesture, now = Date.now()) {
        return this.suspended &&
            this.canResumeGesture(this.state.gesture, gesture) &&
            now - this.state.suspendedAt <= this.resumeWindowMs;
    }

    resume(gesture, hands = [], now = Date.now()) {
        if (!this.canResume(gesture, now)) return false;
        const hand = GestureRuntimeUtils.findHandForGesture(gesture, hands, this.tracker.preferredHand);
        const pos = this.pointerPosition(hand, gesture);
        if (!pos) return false;
        const previousGesture = this.state.gesture;
        const previousOrigin = this.state.origin;
        const previousPosition = this.state.lastPosition;
        const keepOrigin = this.isPointGesture(previousGesture) && this.isPointGesture(gesture);
        this.state.phase = 'active';
        this.state.gesture = gesture;
        this.state.hand = hand?.hand || this.state.hand;
        if (!keepOrigin) {
            const dx = previousPosition.x - previousOrigin.x;
            const dy = previousPosition.y - previousOrigin.y;
            this.state.origin = { x: pos.x - dx, y: pos.y - dy };
        }
        this.state.lastPosition = pos;
        this.state.lastSeenAt = now;
        this.state.lastSentAt = now;
        this.state.suspendedAt = 0;
        this.state.skipNextUpdate = true;
        this.sendAction('pointerMoveStart');
        this.onStateChange(this.state);
        return true;
    }

    expireSuspension(now = Date.now()) {
        if (!this.suspended || now - this.state.suspendedAt <= this.resumeWindowMs) return false;
        this.stop();
        return true;
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
            const pos = this.pointerPosition(hand, this.state.gesture);
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
        if (this.suspended) {
            if (now - this.state.suspendedAt > this.resumeWindowMs) this.stopAllGestureActions();
            return;
        }

        const hand = GestureRuntimeUtils.findHandForGesture(
            this.state.gesture,
            hands,
            this.tracker.preferredHand
        );
        let pos = this.pointerPosition(hand, this.state.gesture);

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
            this.suspend(now);
            return;
        }

        if (this.state.skipNextUpdate) {
            this.state.skipNextUpdate = false;
            this.state.lastSentAt = now;
            return;
        }

        if (now - this.state.lastSentAt < this.intervalMs) return;

        let dx = pos.x - this.state.origin.x;
        const dy = pos.y - this.state.origin.y;
        if (this.tracker.displayMirrored) dx = -dx;

        const maxPixels = this.maxPixels * (Number(this.getSpeedMultiplier()) || 1);
        const left = GestureRuntimeUtils.directionalAmount(dx, this.deadzone, this.maxOffset, maxPixels, this.curvePower);
        const top = GestureRuntimeUtils.directionalAmount(dy, this.deadzone, this.maxOffset, maxPixels, this.curvePower);
        if (!left && !top) return;

        this.state.lastSentAt = now;
        this.sendAction('pointerMove', { left, top });
        this.extendWakeTimeout();
    }
}

class HoldGestureResumeController {
    constructor(options) {
        this.directionalScrollController = options.directionalScrollController;
        this.pointerMoveController = options.pointerMoveController;
        this.continuousGestureGate = options.continuousGestureGate;
        this.getLastFrameHands = options.getLastFrameHands;
        this.extendWakeTimeout = options.extendWakeTimeout;
        this.stopRepeat = options.stopRepeat;
        this.setWakeIdle = options.setWakeIdle;
        this.isWakeGestureEnabled = options.isWakeGestureEnabled;
        this.getWakeActiveDuration = options.getWakeActiveDuration;
        this.setRepeatingGesture = options.setRepeatingGesture;
        this.resumeWindowMs = options.resumeWindowMs ?? HOLD_GESTURE_RESUME_WINDOW_MS;
    }

    suspend(now = Date.now()) {
        this.expire(now);
        if (this.hasSuspended()) return true;
        const directionalSuspended = !!this.directionalScrollController?.suspend(now);
        const pointerSuspended = !!this.pointerMoveController?.suspend(now);
        const suspended = directionalSuspended || pointerSuspended;
        if (suspended && this.isWakeGestureEnabled()) {
            this.extendWakeTimeout(Math.max(this.getWakeActiveDuration(), this.resumeWindowMs));
        }
        return suspended;
    }

    expire(now = Date.now()) {
        const directionalExpired = !!this.directionalScrollController?.expireSuspension(now);
        const pointerExpired = !!this.pointerMoveController?.expireSuspension(now);
        const expired = directionalExpired || pointerExpired;
        if (!expired) return false;
        this.continuousGestureGate?.reset();
        this.stopRepeat();
        if (this.isWakeGestureEnabled()) {
            this.setWakeIdle();
        }
        return true;
    }

    hasSuspended() {
        return !!this.directionalScrollController?.suspended || !!this.pointerMoveController?.suspended;
    }

    resume(gesture, now = Date.now()) {
        const hands = this.getLastFrameHands();
        if (this.directionalScrollController?.resume(gesture, hands, now)) {
            this.setRepeatingGesture(gesture);
            this.continuousGestureGate?.start(gesture);
            this.extendWakeTimeout();
            return 'directionalScroll';
        }
        if (this.pointerMoveController?.resume(gesture, hands, now)) {
            this.extendWakeTimeout();
            return 'pointerMove';
        }
        return null;
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
