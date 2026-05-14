/**
 * 通知音の共有ヘルパー。
 *
 * サイドパネルと PiP は別ページなので AudioContext はページごとに作るが、
 * ビープ音の作り方はここで共通化する。
 */
const NotificationSound = (() => {
    const DEFAULT_ATTACK_SECONDS = 0.015;
    const MIN_GAIN = 0.0001;
    const END_GAIN = 0.001;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function normalizePositiveNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    }

    function createAudioContext() {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        return AudioContextCtor ? new AudioContextCtor() : null;
    }

    function createBeepPlayer(options = {}) {
        const getVolume = typeof options.getVolume === 'function'
            ? options.getVolume
            : () => options.volume ?? 0.3;
        const attackSeconds = normalizePositiveNumber(options.attackSeconds, DEFAULT_ATTACK_SECONDS);
        let audioCtx = null;

        function ensureAudioContext() {
            if (!audioCtx) audioCtx = createAudioContext();
            return audioCtx;
        }

        function play(freq = 880, duration = 0.12) {
            const volume = clamp(Number(getVolume()), 0, 1);
            if (volume <= 0) return;

            try {
                const ctx = ensureAudioContext();
                if (!ctx) return;
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});

                const now = ctx.currentTime;
                const beepDuration = normalizePositiveNumber(duration, 0.12);
                const attack = Math.min(attackSeconds, beepDuration * 0.5);
                const endTime = now + beepDuration;
                const targetVolume = Math.max(MIN_GAIN, volume);

                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(normalizePositiveNumber(freq, 880), now);

                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(MIN_GAIN, now);
                gain.gain.linearRampToValueAtTime(targetVolume, now + attack);
                gain.gain.exponentialRampToValueAtTime(END_GAIN, endTime);

                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.addEventListener('ended', () => {
                    osc.disconnect();
                    gain.disconnect();
                }, { once: true });

                osc.start(now);
                osc.stop(endTime);
            } catch (_) {}
        }

        return { play };
    }

    return { createBeepPlayer };
})();
