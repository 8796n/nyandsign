/**
 * NyandSign — カメラセットアップページ
 *
 * サイドパネルではカメラ許可プロンプトが表示されない場合がある。
 * このページを通常タブとして開き、getUserMedia で許可を取得する。
 * 成功後はストリームを解放し、サイドパネルに通知する。
 */
(() => {
    'use strict';

    const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

    // i18n 適用
    document.documentElement.lang = chrome.i18n.getUILanguage();
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const text = msg(el.dataset.i18n);
        if (text && text !== el.dataset.i18n) el.textContent = text;
    });

    const btn = document.getElementById('btn-allow');
    const statusEl = document.getElementById('status');

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = msg('setupBtnLoading');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 } }
            });

            // ストリームを即座に解放（サイドパネルとの競合を防止）
            stream.getTracks().forEach(t => t.stop());

            // 成功状態を保存（サイドパネルが閉じていた場合の復元用）
            await chrome.storage.local.set({ cameraPermissionReady: true });

            // サイドパネルに即時通知
            try {
                await chrome.runtime.sendMessage({ type: 'camera-permission-granted' });
            } catch (_) {
                // サイドパネルが未起動の場合は無視（storage で復元される）
            }

            statusEl.className = 'status success';
            statusEl.textContent = msg('setupSuccess');
            btn.style.display = 'none';

            // 3秒後に自動でタブを閉じる
            setTimeout(() => {
                try { window.close(); } catch (_) {}
            }, 3000);

        } catch (e) {
            btn.disabled = false;
            btn.textContent = msg('setupBtnAllow');

            if (e?.name === 'NotAllowedError') {
                statusEl.className = 'status error';
                statusEl.innerHTML = msg('setupErrorDenied');
            } else {
                statusEl.className = 'status error';
                statusEl.textContent = msg('setupErrorGeneric', [e?.message || String(e)]);
            }
        }
    });
})();
