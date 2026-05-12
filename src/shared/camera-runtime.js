/* ============================================================
 * カメラランタイム共通部
 *
 * sidepanel.js / pip.js / camera-setup.js で共有する、
 * カメラストリーム取得・video 要素接続・確実な解放の補助関数。
 * UI 更新、ログ、所有権制御は呼び出し側に残す。
 * ============================================================ */

const CameraRuntime = {
    createVideoConstraints(cameraId, { width = 1280, height = 720 } = {}) {
        const video = {
            width: { ideal: width },
            height: { ideal: height },
        };
        if (cameraId) {
            video.deviceId = { exact: cameraId };
        }
        return video;
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
};
