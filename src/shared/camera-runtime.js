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
    XREAL_RGB_VIDEO_WIDTH: 1920,
    XREAL_RGB_VIDEO_HEIGHT: 1080,
    DEFAULT_RESTART_DEBOUNCE_MS: 400,

    createVideoConstraints(cameraId, options = {}) {
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

    requestOptionsForInferenceResolution(inferenceResolution, cameraHint = null) {
        // XREAL Eye の RGB UVC は低解像度の横長モードを広告しないため、
        // カメラ取得は 1920x1080 に固定し、推論入力だけ内部で縮小する。
        if (this.isXrealCamera(cameraHint)) {
            return this.xrealRgbVideoOptions();
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

    isXrealRgbVideoOptions(options = {}) {
        return Number(options.width) === this.XREAL_RGB_VIDEO_WIDTH
            && Number(options.height) === this.XREAL_RGB_VIDEO_HEIGHT;
    },

    requestedVideoSize(options = {}) {
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

    requestCameraStream(cameraId, options = {}) {
        return navigator.mediaDevices.getUserMedia(
            this.createStreamConstraints(cameraId, options)
        );
    },

    async requestTrackingCameraStream(cameraId, options = {}) {
        const stream = await this.requestCameraStream(cameraId, options);
        return this.normalizeTrackingCameraStream(stream, cameraId, options);
    },

    async normalizeTrackingCameraStream(stream, cameraId, requestOptions = {}) {
        const track = this.primaryVideoTrack(stream);
        if (!this.isXrealCamera(track) || this.isXrealRgbVideoOptions(requestOptions)) {
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

    isXrealCamera(deviceOrLabel) {
        const label = typeof deviceOrLabel === 'string'
            ? deviceOrLabel
            : deviceOrLabel?.label || '';
        return /XREAL|3318|Nreal|0486|0817|0909/.test(label);
    },

    waitForLoadedData(videoEl) {
        if (!videoEl || videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            videoEl.addEventListener('loadeddata', resolve, { once: true });
        });
    },

    async attachStreamToVideo(videoEl, stream, { play = false } = {}) {
        if (!videoEl) return;
        videoEl.srcObject = stream;
        await this.waitForLoadedData(videoEl);
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
