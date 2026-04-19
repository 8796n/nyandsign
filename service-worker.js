/**
 * NyandSign — Service Worker
 *
 * Side Panel / PiP ポップアップからサインアクションを受信し、
 * アクティブタブの Content Script へ転送する。
 * 単一インスタンス制御: カメラ+認識は全体で1つだけ許可し、
 * 新しいインスタンスが起動すると古いインスタンスを停止させる。
 */

// アクションボタンクリックで Side Panel を開く
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

/* ============================================================
 * 単一インスタンス制御
 * ============================================================
 * Service Worker が認識インスタンスの所有権を管理する。
 * claim-active-instance: 新しいインスタンスが所有権を要求
 * release-active-instance: インスタンスが所有権を解放
 * 所有権が移った場合は instance-takeover をブロードキャストし、
 * 旧インスタンスに停止を通知する。
 */
let activeInstance = null; // { instanceId, type, windowId, targetTabId }

/** 全拡張ページに instance-takeover をブロードキャスト */
async function broadcastTakeover(newInstance) {
    try {
        // 全拡張ページ（サイドパネル、ポップアップ等）に通知
        await chrome.runtime.sendMessage({
            type: 'instance-takeover',
            instanceId: newInstance.instanceId,
        });
    } catch (_) {
        // 受信者がいない場合は無視
    }
}

/**
 * Side Panel / PiP ポップアップからのメッセージを処理する。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'gesture-action') {
        forwardToActiveTab(message.action, message.targetTabId);
        sendResponse({ ok: true });
        return true;
    }

    // 単一インスタンス制御: 所有権の要求
    if (message.type === 'claim-active-instance') {
        const prev = activeInstance;
        activeInstance = {
            instanceId: message.instanceId,
            type: message.instanceType,       // 'sidepanel' | 'popup'
            windowId: message.windowId || null,
            targetTabId: message.targetTabId || null,
        };
        // 旧インスタンスが存在し、別のインスタンスなら停止通知
        if (prev && prev.instanceId !== message.instanceId) {
            broadcastTakeover(activeInstance);
        }
        sendResponse({ ok: true });
        return true;
    }

    // 単一インスタンス制御: 所有権の解放
    if (message.type === 'release-active-instance') {
        // 呼び出し元がまだ所有者の場合のみクリア（他に奪われていたら何もしない）
        if (activeInstance && activeInstance.instanceId === message.instanceId) {
            activeInstance = null;
        }
        sendResponse({ ok: true });
        return true;
    }

    return false;
});

/**
 * ポップアップのライフサイクルポート
 * ポップアップが閉じられると onDisconnect が確実に発火するため、
 * beforeunload + sendMessage より信頼性が高い。
 */
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'pip-lifecycle') return;
    let pipInfo = null;
    let skipReturn = false;
    port.onMessage.addListener((msg) => {
        if (msg.skipReturn) {
            skipReturn = true;
        } else {
            pipInfo = msg;
        }
    });
    port.onDisconnect.addListener(async () => {
        if (skipReturn || !pipInfo?.browserWindowId) return;
        // カメラ自動再開フラグを設定
        await chrome.storage.session.set({
            pipReturnToSidepanel: { cameraId: pipInfo.cameraId || '' },
        }).catch(() => {});
    });
});

/**
 * アクションをアクティブタブに送信する。
 * targetTabId が指定されている場合はそのタブに直接送信する。
 * 未指定の場合は通常ウィンドウのアクティブタブを検索する。
 */
async function forwardToActiveTab(action, targetTabId) {
    if (!action || action === 'none') return;

    let tabId;

    if (targetTabId) {
        // 指定タブが存在するか確認
        try {
            await chrome.tabs.get(targetTabId);
            tabId = targetTabId;
        } catch (_) {
            // タブが閉じられている場合はフォールバック
            tabId = null;
        }
    }

    if (!tabId) {
        // 通常ウィンドウのアクティブタブを検索（ポップアップウィンドウを除外）
        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tabs.length > 0) {
            const win = await chrome.windows.get(tabs[0].windowId);
            if (win.type !== 'normal') {
                const allTabs = await chrome.tabs.query({ active: true });
                for (const tab of allTabs) {
                    const w = await chrome.windows.get(tab.windowId);
                    if (w.type === 'normal') { tabs = [tab]; break; }
                }
            }
        }
        if (tabs.length === 0) return;
        tabId = tabs[0].id;
    }

    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'mediaAction',
            action,
        });
    } catch (err) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content-script.js'],
            });
            await chrome.tabs.sendMessage(tabId, {
                type: 'mediaAction',
                action,
            });
        } catch (_) {
            // chrome:// 等の注入不可ページは無視
        }
    }
}
