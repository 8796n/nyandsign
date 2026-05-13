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
const FRAME_REGISTRY_RETRY_DELAY_MS = 150;
const frameRegistryByTab = new Map(); // tabId -> { byPath, byFrameId }

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
        forwardToActiveTab(message.action, message.targetTabId, message.data)
            .then(sendResponse)
            .catch((err) => {
                sendResponse({
                    ok: false,
                    reason: 'unknown',
                    message: err?.message || String(err),
                });
            });
        return true;
    }

    if (message.type === 'register-content-frame') {
        registerContentFrame(message, sender);
        sendResponse({ ok: true });
        return true;
    }

    if (message.type === 'route-frame-action') {
        routeFrameAction(message, sender)
            .then(sendResponse)
            .catch((err) => {
                sendResponse({
                    ok: false,
                    reason: 'frameActionUnavailable',
                    message: err?.message || String(err),
                });
            });
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        frameRegistryByTab.delete(tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    frameRegistryByTab.delete(tabId);
});

/**
 * アクションをアクティブタブに送信する。
 * targetTabId が指定されている場合はそのタブに直接送信する。
 * 未指定の場合は通常ウィンドウのアクティブタブを検索する。
 */
async function resolveTargetTab(targetTabId) {
    if (targetTabId) {
        try {
            return await chrome.tabs.get(targetTabId);
        } catch (_) {
            // タブが閉じられている場合はフォールバック
        }
    }

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
    return tabs[0] || null;
}

async function activateAdjacentTab(tab, direction) {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    const ordered = tabs.sort((a, b) => a.index - b.index);
    const currentIndex = ordered.findIndex(t => t.id === tab.id);
    if (currentIndex < 0 || ordered.length < 2) return;
    const nextIndex = (currentIndex + direction + ordered.length) % ordered.length;
    await chrome.tabs.update(ordered[nextIndex].id, { active: true });
}

async function adjustZoom(tabId, delta) {
    const current = await chrome.tabs.getZoom(tabId);
    const next = Math.max(0.25, Math.min(5, Math.round((current + delta) * 100) / 100));
    await chrome.tabs.setZoom(tabId, next);
}

async function executeBrowserTabAction(action, tab) {
    switch (action) {
        case 'historyBack':
            await chrome.tabs.goBack(tab.id);
            return true;
        case 'historyForward':
            await chrome.tabs.goForward(tab.id);
            return true;
        case 'nextTab':
            await activateAdjacentTab(tab, 1);
            return true;
        case 'previousTab':
            await activateAdjacentTab(tab, -1);
            return true;
        case 'reload':
            await chrome.tabs.reload(tab.id);
            return true;
        case 'zoomIn':
            await adjustZoom(tab.id, 0.1);
            return true;
        case 'zoomOut':
            await adjustZoom(tab.id, -0.1);
            return true;
        case 'resetZoom':
            await chrome.tabs.setZoom(tab.id, 0);
            return true;
        default:
            return false;
    }
}

function isRestrictedPageForInjection(tab) {
    const url = tab?.url || '';
    return /^(chrome|chrome-extension|chrome-untrusted|edge|about|devtools|view-source):/i.test(url);
}

function pageActionFailureReason(tab) {
    return isRestrictedPageForInjection(tab) ? 'restrictedPage' : 'reloadRequired';
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeFramePath(path) {
    if (!Array.isArray(path)) return null;
    const result = [];
    for (const value of path) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) return null;
        result.push(n);
    }
    return result;
}

function framePathKey(path) {
    return JSON.stringify(path || []);
}

function getFrameRegistry(tabId) {
    let registry = frameRegistryByTab.get(tabId);
    if (!registry) {
        registry = {
            byPath: new Map(),
            byFrameId: new Map(),
        };
        frameRegistryByTab.set(tabId, registry);
    }
    return registry;
}

function registerContentFrame(message, sender) {
    const tabId = sender.tab?.id;
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
    const framePath = normalizeFramePath(message.framePath);
    if (!Number.isInteger(tabId) || !framePath) return;

    const registry = getFrameRegistry(tabId);
    const entry = {
        frameId,
        framePath,
        url: sender.url || '',
        updatedAt: Date.now(),
    };
    registry.byPath.set(framePathKey(framePath), entry);
    registry.byFrameId.set(frameId, entry);
}

function contentActionMessage(action, data) {
    return {
        type: 'mediaAction',
        action,
        data,
    };
}

async function sendContentAction(tabId, action, data, frameId = null) {
    const message = contentActionMessage(action, data);
    if (Number.isInteger(frameId)) {
        return await chrome.tabs.sendMessage(tabId, message, { frameId });
    }
    return await chrome.tabs.sendMessage(tabId, message);
}

async function injectContentScriptAllFrames(tabId) {
    return await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['src/content/content-script.js'],
    });
}

function registeredFrameId(tabId, framePath) {
    const normalizedPath = normalizeFramePath(framePath);
    if (!normalizedPath) return null;
    if (normalizedPath.length === 0) return 0;
    return getFrameRegistry(tabId).byPath.get(framePathKey(normalizedPath))?.frameId ?? null;
}

async function resolveFrameId(tabId, framePath) {
    let frameId = registeredFrameId(tabId, framePath);
    if (frameId !== null) return frameId;

    await injectContentScriptAllFrames(tabId);
    await delay(FRAME_REGISTRY_RETRY_DELAY_MS);
    frameId = registeredFrameId(tabId, framePath);
    return frameId;
}

async function routeFrameAction(message, sender) {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) return { ok: false, reason: 'noTargetTab' };

    const framePath = normalizeFramePath(message.framePath);
    if (!framePath) return { ok: false, reason: 'frameActionUnavailable' };

    const frameId = await resolveFrameId(tabId, framePath);
    if (frameId === null) {
        return {
            ok: false,
            reason: 'frameActionUnavailable',
            targetFramePath: framePath,
        };
    }

    try {
        const result = await sendContentAction(tabId, message.action, message.data, frameId);
        if (result?.ok === false) return result;
        return {
            ok: true,
            handledBy: 'contentScriptFrame',
            frameId,
            targetFramePath: framePath,
        };
    } catch (err) {
        return {
            ok: false,
            reason: 'frameActionUnavailable',
            frameId,
            targetFramePath: framePath,
            message: err?.message || String(err),
        };
    }
}

async function forwardToActiveTab(action, targetTabId, data) {
    if (!action || action === 'none') return { ok: true, handledBy: 'none' };

    const tab = await resolveTargetTab(targetTabId);
    if (!tab?.id) return { ok: false, reason: 'noTargetTab' };

    try {
        if (await executeBrowserTabAction(action, tab)) {
            return { ok: true, handledBy: 'tab' };
        }
    } catch (err) {
        return {
            ok: false,
            reason: 'tabActionFailed',
            message: err?.message || String(err),
        };
    }

    try {
        const result = await sendContentAction(tab.id, action, data, 0);
        if (result?.ok === false) return result;
        return { ok: true, handledBy: 'contentScript', frameId: 0 };
    } catch (err) {
        let injectionResults = [];
        try {
            injectionResults = await injectContentScriptAllFrames(tab.id);
            await delay(FRAME_REGISTRY_RETRY_DELAY_MS);
        } catch (injectErr) {
            // chrome:// 等は注入不可。通常ページで失敗した場合は再読み込み候補として扱う。
            return {
                ok: false,
                reason: pageActionFailureReason(tab),
                message: injectErr?.message || err?.message || String(injectErr || err),
            };
        }
        if (!injectionResults.length) {
            return {
                ok: false,
                reason: pageActionFailureReason(tab),
                injectedFrameCount: 0,
                message: err?.message || 'no injected frame',
            };
        }

        try {
            const result = await sendContentAction(tab.id, action, data, 0);
            if (result?.ok === false) return result;
            return {
                ok: true,
                handledBy: 'contentScript',
                reinjected: true,
                frameId: 0,
                injectedFrameCount: injectionResults.length,
            };
        } catch (retryErr) {
            return {
                ok: false,
                reason: injectionResults.length > 1 ? 'frameActionUnavailable' : 'reloadRequired',
                injectedFrameCount: injectionResults.length,
                message: retryErr?.message || err?.message || String(retryErr || err),
            };
        }
    }
}
