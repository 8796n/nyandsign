/* ============================================================
 * カメラランタイム共通部
 *
 * sidepanel.js / pip.js / camera-setup.js で共有する、
 * カメラストリーム取得・video 要素接続・確実な解放の補助関数。
 * UI 更新、ログ、所有権制御は呼び出し側に残す。
 * ============================================================ */

const CameraRuntime = {
    DEFAULT_VIDEO_WIDTH: 1280,
    DEFAULT_VIDEO_HEIGHT: 720,
    XREAL_CAMERA_PROFILE_RGB: 'xreal-rgb',
    XREAL_CAMERA_PROFILE_MONO: 'xreal-mono',
    XREAL_RGB_VIDEO_WIDTH: 1920,
    XREAL_RGB_VIDEO_HEIGHT: 1080,
    XREAL_MONO_VIDEO_WIDTH: 512,
    XREAL_MONO_VIDEO_HEIGHT: 378,
    DEFAULT_RESTART_DEBOUNCE_MS: 400,
    DEFAULT_VIDEO_LOAD_TIMEOUT_MS: 5000,

    createVideoConstraints(cameraId, options = {}) {
        if (options.deviceOnly) {
            const video = {};
            if (cameraId) {
                video.deviceId = { exact: cameraId };
            }
            return video;
        }
        const { width = this.DEFAULT_VIDEO_WIDTH, height = this.DEFAULT_VIDEO_HEIGHT } = options;
        const video = {
            width: { ideal: width },
            height: { ideal: height },
        };
        if (cameraId) {
            video.deviceId = { exact: cameraId };
        }
        return video;
    },

    defaultVideoOptions() {
        return {
            width: this.DEFAULT_VIDEO_WIDTH,
            height: this.DEFAULT_VIDEO_HEIGHT,
        };
    },

    deviceOnlyVideoOptions() {
        return { deviceOnly: true };
    },

    requestOptionsForInferenceResolution(inferenceResolution, cameraHint = null) {
        const xrealProfile = this.xrealCameraProfile(cameraHint);
        // XREAL Eye の UVC1 は 6DoF 用の白黒低解像度カメラ。
        // UVC0 の RGB カメラだけ 1920x1080 に寄せ、UVC1 はネイティブ解像度で取得する。
        if (xrealProfile === this.XREAL_CAMERA_PROFILE_MONO) {
            return this.xrealMonoVideoOptions();
        }
        // XREAL Eye の RGB UVC0 は低解像度の横長モードを広告しないため、
        // カメラ取得は 1920x1080 に固定し、推論入力だけ内部で縮小する。
        if (xrealProfile === this.XREAL_CAMERA_PROFILE_RGB) {
            return this.xrealRgbVideoOptions();
        }
        if (this.isXrealCamera(cameraHint)) {
            return this.deviceOnlyVideoOptions();
        }
        const options = typeof inferenceResolutionToCameraOptions === 'function'
            ? inferenceResolutionToCameraOptions(inferenceResolution)
            : null;
        return options || this.defaultVideoOptions();
    },

    xrealRgbVideoOptions() {
        return {
            width: this.XREAL_RGB_VIDEO_WIDTH,
            height: this.XREAL_RGB_VIDEO_HEIGHT,
        };
    },

    xrealMonoVideoOptions() {
        return {
            width: this.XREAL_MONO_VIDEO_WIDTH,
            height: this.XREAL_MONO_VIDEO_HEIGHT,
        };
    },

    isXrealRgbVideoOptions(options = {}) {
        return Number(options.width) === this.XREAL_RGB_VIDEO_WIDTH
            && Number(options.height) === this.XREAL_RGB_VIDEO_HEIGHT;
    },

    isXrealMonoVideoOptions(options = {}) {
        return Number(options.width) === this.XREAL_MONO_VIDEO_WIDTH
            && Number(options.height) === this.XREAL_MONO_VIDEO_HEIGHT;
    },

    requestedVideoSize(options = {}) {
        if (options.deviceOnly) return { width: null, height: null };
        return {
            width: options.width ?? this.DEFAULT_VIDEO_WIDTH,
            height: options.height ?? this.DEFAULT_VIDEO_HEIGHT,
        };
    },

    trackResolution(track) {
        const settings = track?.getSettings?.() || {};
        return {
            width: settings.width || null,
            height: settings.height || null,
        };
    },

    formatResolution(size) {
        if (!size?.width || !size?.height) return '-';
        return `${Math.round(size.width)}x${Math.round(size.height)}`;
    },

    cameraResolutionLogArgs(requestOptions, track) {
        return [
            this.formatResolution(this.requestedVideoSize(requestOptions)),
            this.formatResolution(this.trackResolution(track)),
        ];
    },

    inferenceResolutionLogArgs(tracker, inferenceResolution) {
        const label = typeof inferenceResolutionLabel === 'function'
            ? inferenceResolutionLabel(inferenceResolution)
            : String(inferenceResolution || '');
        return [
            label,
            this.formatResolution(tracker?.getInferenceInputSize?.()),
        ];
    },

    createStreamConstraints(cameraId, options = {}) {
        return {
            video: this.createVideoConstraints(cameraId, options),
        };
    },

    createDeviceOnlyStreamConstraints(cameraId) {
        return {
            video: cameraId ? { deviceId: { exact: cameraId } } : true,
        };
    },

    requestCameraStream(cameraId, options = {}) {
        return navigator.mediaDevices.getUserMedia(
            this.createStreamConstraints(cameraId, options)
        );
    },

    async requestTrackingCameraStream(cameraId, options = {}) {
        try {
            const stream = await this.requestCameraStream(cameraId, options);
            return this.normalizeTrackingCameraStream(stream, cameraId, options);
        } catch (e) {
            if (!this.shouldRetryXrealMonoCamera(e, options)) throw e;
            const monoOptions = this.xrealMonoVideoOptions();
            try {
                const stream = await this.requestCameraStream(cameraId, monoOptions);
                const result = await this.normalizeTrackingCameraStream(stream, cameraId, monoOptions);
                return {
                    ...result,
                    fallbackProfile: this.XREAL_CAMERA_PROFILE_MONO,
                    fallbackError: e,
                };
            } catch (monoError) {
                const deviceOnlyOptions = this.deviceOnlyVideoOptions();
                const stream = await this.requestCameraStream(cameraId, deviceOnlyOptions);
                const result = await this.normalizeTrackingCameraStream(stream, cameraId, deviceOnlyOptions);
                return {
                    ...result,
                    fallbackProfile: this.xrealCameraProfile(result.track) || this.XREAL_CAMERA_PROFILE_MONO,
                    fallbackError: monoError,
                    fallbackMode: 'device-only',
                };
            }
        }
    },

    async normalizeTrackingCameraStream(stream, cameraId, requestOptions = {}) {
        const track = this.primaryVideoTrack(stream);
        if (!this.isXrealCamera(track)) {
            return { stream, track, requestOptions };
        }
        const profile = this.xrealCameraProfile(track);
        if (profile === this.XREAL_CAMERA_PROFILE_MONO || this.isXrealMonoVideoOptions(requestOptions)) {
            return { stream, track, requestOptions: this.xrealMonoVideoOptions() };
        }
        if (this.isXrealRgbVideoOptions(requestOptions)) {
            return { stream, track, requestOptions };
        }
        if (requestOptions.deviceOnly || !profile) {
            return { stream, track, requestOptions };
        }

        const xrealOptions = this.xrealRgbVideoOptions();
        const xrealCameraId = this.cameraDeviceId(stream) || cameraId;
        this.releaseCameraStream(stream, null);

        const xrealStream = await this.requestCameraStream(xrealCameraId, xrealOptions);
        return {
            stream: xrealStream,
            track: this.primaryVideoTrack(xrealStream),
            requestOptions: xrealOptions,
        };
    },

    primaryVideoTrack(stream) {
        return stream?.getVideoTracks?.()[0] || null;
    },

    cameraDeviceId(stream) {
        return this.primaryVideoTrack(stream)?.getSettings?.().deviceId || null;
    },

    normalizeXrealCameraProfile(profile) {
        switch (String(profile || '').toLowerCase()) {
            case this.XREAL_CAMERA_PROFILE_RGB:
            case 'rgb':
            case 'uvc0':
            case 'xreal0':
                return this.XREAL_CAMERA_PROFILE_RGB;
            case this.XREAL_CAMERA_PROFILE_MONO:
            case 'mono':
            case 'monochrome':
            case 'uvc1':
            case 'xreal1':
                return this.XREAL_CAMERA_PROFILE_MONO;
            default:
                return null;
        }
    },

    capabilityMaxValue(value) {
        if (typeof value === 'object' && value !== null) return Number(value.max);
        return Number(value);
    },

    detectXrealCameraProfile(deviceOrLabel) {
        const explicitProfile = this.normalizeXrealCameraProfile(
            typeof deviceOrLabel === 'string' ? deviceOrLabel : deviceOrLabel?.xrealCameraProfile
        );
        if (explicitProfile) return explicitProfile;

        const settings = deviceOrLabel?.getSettings?.() || {};
        const width = Number(settings.width || deviceOrLabel?.width);
        const height = Number(settings.height || deviceOrLabel?.height);
        if (Number.isFinite(width) && Number.isFinite(height)) {
            if (width <= 640 && height <= 480) return this.XREAL_CAMERA_PROFILE_MONO;
            if (width >= 1280 || height >= 720) return this.XREAL_CAMERA_PROFILE_RGB;
        }

        const capabilities = deviceOrLabel?.getCapabilities?.() || deviceOrLabel?.capabilities || {};
        const maxWidth = this.capabilityMaxValue(capabilities.width);
        const maxHeight = this.capabilityMaxValue(capabilities.height);
        if (Number.isFinite(maxWidth) && Number.isFinite(maxHeight)) {
            if (maxWidth <= 640 && maxHeight <= 480) return this.XREAL_CAMERA_PROFILE_MONO;
            if (maxWidth >= 1280 || maxHeight >= 720) return this.XREAL_CAMERA_PROFILE_RGB;
        }

        const label = typeof deviceOrLabel === 'string'
            ? deviceOrLabel
            : deviceOrLabel?.label || '';
        if (/\b(?:UVC\s*Camera|Video\s*Streaming)\s*1\b/i.test(label)
            || /\buvc\s*1\b/i.test(label)
            || /\bxreal\s*1\b/i.test(label)
            || /\bxreal1\b/i.test(label)) {
            return this.XREAL_CAMERA_PROFILE_MONO;
        }
        if (/\b(?:UVC\s*Camera|Video\s*Streaming)\s*0\b/i.test(label)
            || /\buvc\s*0\b/i.test(label)
            || /\bxreal\s*0\b/i.test(label)
            || /\bxreal0\b/i.test(label)) {
            return this.XREAL_CAMERA_PROFILE_RGB;
        }
        return null;
    },

    xrealCameraProfile(deviceOrLabel) {
        if (!this.isXrealCamera(deviceOrLabel)) return null;
        return this.detectXrealCameraProfile(deviceOrLabel);
    },

    xrealCameraHint(profile) {
        const normalized = this.normalizeXrealCameraProfile(profile);
        return normalized ? { label: 'XREAL', xrealCameraProfile: normalized } : null;
    },

    annotateCameraDevices(cameras = [], knownProfiles = {}) {
        const normalized = cameras.map(camera => ({
            deviceId: camera.deviceId || '',
            groupId: camera.groupId || '',
            kind: camera.kind || '',
            label: camera.label || '',
        }));
        return normalized.map(camera => {
            if (!this.isXrealCamera(camera)) return camera;
            const detectedProfile = this.normalizeXrealCameraProfile(knownProfiles[camera.deviceId])
                || this.detectXrealCameraProfile(camera);
            if (!detectedProfile) return camera;
            return {
                ...camera,
                xrealCameraProfile: detectedProfile,
            };
        });
    },

    async probeXrealCameraProfile(cameraId) {
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia(
                this.createDeviceOnlyStreamConstraints(cameraId)
            );
            const track = this.primaryVideoTrack(stream);
            return this.detectXrealCameraProfile(track);
        } finally {
            this.releaseCameraStream(stream, null);
        }
    },

    shouldRetryXrealMonoCamera(error, options = {}) {
        if (!this.isXrealRgbVideoOptions(options)) return false;
        return ['NotReadableError', 'OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(error?.name);
    },

    isXrealCamera(deviceOrLabel) {
        if (this.normalizeXrealCameraProfile(deviceOrLabel)) return true;
        if (this.normalizeXrealCameraProfile(deviceOrLabel?.xrealCameraProfile)) return true;
        const label = typeof deviceOrLabel === 'string'
            ? deviceOrLabel
            : deviceOrLabel?.label || '';
        return /XREAL|3318|Nreal|0486|0817|0909/.test(label);
    },

    waitForLoadedData(videoEl, timeoutMs = this.DEFAULT_VIDEO_LOAD_TIMEOUT_MS) {
        if (!videoEl || videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let timer = null;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                videoEl.removeEventListener('loadeddata', onLoaded);
                videoEl.removeEventListener('error', onError);
            };
            const onLoaded = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                const error = new Error('Camera video failed to load');
                error.name = 'NotReadableError';
                reject(error);
            };

            videoEl.addEventListener('loadeddata', onLoaded, { once: true });
            videoEl.addEventListener('error', onError, { once: true });
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    cleanup();
                    const error = new Error('Camera video did not produce frames in time');
                    error.name = 'TimeoutError';
                    reject(error);
                }, timeoutMs);
            }
        });
    },

    async attachStreamToVideo(videoEl, stream, { play = false, loadTimeoutMs = this.DEFAULT_VIDEO_LOAD_TIMEOUT_MS } = {}) {
        if (!videoEl) return;
        videoEl.srcObject = stream;
        await this.waitForLoadedData(videoEl, loadTimeoutMs);
        if (play) {
            await videoEl.play();
        }
    },

    clearMediaElementSource(mediaEl) {
        if (!mediaEl) return;
        mediaEl.srcObject = null;
    },

    releaseMediaStream(stream) {
        if (!stream) return null;
        for (const track of stream.getTracks()) {
            try { track.stop(); } catch (_) {}
        }
        return null;
    },

    releaseElementStream(mediaEl) {
        const stream = mediaEl?.srcObject instanceof MediaStream
            ? mediaEl.srcObject
            : null;
        this.clearMediaElementSource(mediaEl);
        return this.releaseMediaStream(stream);
    },

    releaseCameraStream(stream, videoEl) {
        this.releaseMediaStream(stream);
        this.clearMediaElementSource(videoEl);
        return null;
    },

    createRestartController({ debounceMs = this.DEFAULT_RESTART_DEBOUNCE_MS, isActive, restart }) {
        let timer = null;
        let seq = 0;
        return {
            schedule() {
                if (isActive && !isActive()) return;
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = null;
                    restart?.();
                }, debounceMs);
            },
            cancel() {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                seq++;
            },
            nextSeq() {
                seq++;
                return seq;
            },
            isCurrent(value) {
                return value === seq;
            },
        };
    },

    async restartTrackingCamera({
        currentStream,
        videoEl,
        tracker,
        canvasEl,
        cameraId,
        requestOptions,
        attachOptions = {},
        trackerOptions = {},
        beforeStop,
        beforeStart,
        isCurrent = () => true,
    }) {
        beforeStop?.();
        tracker?.stop?.();
        this.releaseCameraStream(currentStream, videoEl);

        let stream = null;
        try {
            const cameraResult = await this.requestTrackingCameraStream(cameraId, requestOptions);
            stream = cameraResult.stream;
            requestOptions = cameraResult.requestOptions;
            if (!isCurrent()) {
                this.releaseCameraStream(stream, null);
                return { stale: true, stream: null, track: null, requestOptions };
            }

            const track = cameraResult.track;
            beforeStart?.({ stream, track, requestOptions });
            await this.attachStreamToVideo(videoEl, stream, attachOptions);
            await tracker.start(videoEl, canvasEl, trackerOptions);
            return { stale: false, stream, track, requestOptions };
        } catch (e) {
            if (stream) this.releaseCameraStream(stream, videoEl);
            throw e;
        }
    },
};
