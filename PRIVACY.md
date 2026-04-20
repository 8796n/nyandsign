# Privacy Policy — NyandSign

**Last updated: 2026-04-20**

---

## English

### Overview

NyandSign is a Chrome extension that detects hand signs via your webcam and maps them to media playback controls. This privacy policy explains what information NyandSign handles, how it is used, and what is shared with third parties.

**Summary: NyandSign does not collect, transmit, or sell any personal data. All processing happens locally on your device.**

---

### Camera Access

NyandSign requests access to your camera for the sole purpose of detecting hand signs.

- Camera frames are processed **entirely on your device** using Google MediaPipe (WebAssembly), running inside your browser.
- Camera images and video are **never transmitted** to any server, cloud service, or third party.
- No images or frames are saved to disk or stored anywhere outside your browser session.

---

### Data Stored Locally

NyandSign stores your preferences using Chrome's built-in storage APIs. No external database or server is involved.

| Storage type | What is stored |
|---|---|
| `chrome.storage.sync` | Gesture mappings, gesture hold time, wake gesture, toggle gesture, volume, display settings, UI scale, PiP font scale, preferred hand |
| `chrome.storage.local` | Selected camera device ID, camera permission status |

**`chrome.storage.sync` note:** If you are signed into Chrome with a Google account and have Chrome Sync enabled, Chrome itself may sync this settings data across your devices through Google's infrastructure. This synchronization is handled entirely by Chrome and Google — NyandSign does not initiate or control it. For details, see [Google's Privacy Policy](https://policies.google.com/privacy).

If you are not signed into Chrome, all data remains on your local device only.

---

### Tab Information

NyandSign reads tab titles and URLs solely to display a list of open tabs in the "Target Tab" feature, allowing you to choose which tab receives media commands.

- Tab information is used only within the extension's side panel UI.
- Tab titles and URLs are **never transmitted** outside your browser.

---

### No Analytics or Tracking

NyandSign does **not** include:

- Analytics or telemetry of any kind
- Crash reporting services
- Advertising or tracking pixels
- Third-party SDKs that collect data (MediaPipe runs entirely on-device via WebAssembly)

---

### Third-Party Libraries

NyandSign bundles Google MediaPipe (Hand Landmarker) as a vendored WebAssembly library. This library runs entirely on-device and does not make any network requests. It is used solely for hand landmark detection.

- License: Apache License 2.0
- Source: https://github.com/google-ai-edge/mediapipe

---

### Changes to This Policy

If this policy is updated, the "Last updated" date at the top of this document will be revised. Continued use of the extension after changes constitutes acceptance of the updated policy.

---

### Contact

For questions or concerns about this privacy policy, please open an issue at:
https://github.com/8796n/nyandsign/issues

---

---

## 日本語

### 概要

NyandSign は、ウェブカメラでハンドサインを検出してメディア再生を操作する Chrome 拡張機能です。このプライバシーポリシーでは、NyandSign が扱う情報・その用途・第三者との共有について説明します。

**要約: NyandSign は個人データを収集・送信・販売しません。すべての処理はあなたのデバイス上でローカルに完結します。**

---

### カメラへのアクセス

NyandSign がカメラにアクセスする目的は、ハンドサインの検出のみです。

- カメラ映像は、ブラウザ内で動作する Google MediaPipe（WebAssembly）を使用して**すべてデバイス上で処理**されます。
- カメラ映像・画像は、いかなるサーバー・クラウドサービス・第三者にも**送信されません**。
- 画像やフレームはディスクに保存されず、ブラウザセッション外のいかなる場所にも保存されません。

---

### ローカルに保存されるデータ

NyandSign は Chrome の組み込みストレージ API を使って設定を保存します。外部データベースやサーバーは一切使用しません。

| ストレージ種別 | 保存内容 |
|---|---|
| `chrome.storage.sync` | ジェスチャーマッピング、保持時間、ウェイクサイン、トグルジェスチャー、音量、表示設定、UIスケール、PiPフォントサイズ、利き手設定 |
| `chrome.storage.local` | 選択中のカメラデバイスID、カメラ権限の状態 |

**`chrome.storage.sync` について:** Chrome に Google アカウントでサインインしており Chrome 同期が有効な場合、Chrome 自体がこの設定データを Google のインフラを通じて複数デバイス間で同期することがあります。この同期は Chrome および Google によって行われるものであり、NyandSign が主体的に行うものではありません。詳細は [Google のプライバシーポリシー](https://policies.google.com/privacy) をご確認ください。

Chrome にサインインしていない場合、すべてのデータはお使いのデバイスにのみ保存されます。

---

### タブ情報

NyandSign はタブのタイトルと URL を読み取ります。これは「ターゲットタブ」機能において、メディアコマンドの送信先タブをサイドパネル内で選択できるようにするためのみに使用します。

- タブの情報はサイドパネルの UI 表示にのみ使用されます。
- タブのタイトルや URL はブラウザの外部に**送信されません**。

---

### アナリティクス・トラッキングなし

NyandSign には以下が一切含まれません：

- アナリティクスやテレメトリ
- クラッシュレポートサービス
- 広告・トラッキングピクセル
- データを収集するサードパーティ SDK（MediaPipe はデバイス上の WebAssembly で動作します）

---

### サードパーティライブラリ

NyandSign は Google MediaPipe（Hand Landmarker）を WebAssembly ライブラリとして同梱しています。このライブラリはデバイス上でのみ動作し、ネットワークリクエストを一切行いません。手のランドマーク検出のみに使用しています。

- ライセンス: Apache License 2.0
- ソース: https://github.com/google-ai-edge/mediapipe

---

### ポリシーの変更

このポリシーを更新した場合、文書上部の「Last updated」日付を更新します。変更後も拡張機能を継続して使用することで、更新されたポリシーへの同意とみなします。

---

### お問い合わせ

このプライバシーポリシーに関するご質問・ご意見は、以下の GitHub Issues までお寄せください：
https://github.com/8796n/nyandsign/issues
