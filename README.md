# <img src="https://github.com/8796n/nyandsign/blob/main/icons/icon128.png?raw=true" width="48" alt="NyandSign Icon"> NyandSign

Hand sign control for media playback and browser actions.

ウェブカメラでハンドサインを検出し、メディア再生やスクロール・タブ切り替えなどのブラウザ操作をハンズフリーで行う Chrome 拡張機能です。

---

## ✨ 概要

NyandSign は Google MediaPipe のオンデバイス AI を使い、リアルタイムでハンドサインを検出してブラウザ上の操作にマッピングします。すべての処理はブラウザ内でローカルに完結し、カメラ映像が外部サーバーに送信されることはありません。

メディア操作モードでは YouTube、Spotify、Netflix などの再生を操作できます。ブラウザ操作モードではページスクロール、戻る/進む、タブ切り替え、ズーム、カーソル移動などを操作できます。

通常のウェブカメラに加えて、対応する電気メガネのカメラとも組み合わせて使えます。

## 主な機能

### 🖐️ ハンドサイン認識

11種類の片手ハンドサインを認識します。

| サイン | 説明 |
|---|---|
| ✊ グー | fist |
| ✌️ チョキ | peace |
| 3️⃣ 3本指 | three |
| 4️⃣ 4本指 | four |
| 👌 OK | ok |
| 🤙 アロハ | aloha |
| 🤘 ロック | rock |
| 👉 右指差し | point-right |
| 👈 左指差し | point-left |
| 👍 サムズアップ | thumbsup |
| 👎 サムズダウン | thumbsdown |

各サインには、操作モードごとに別々のアクションを割り当てられます。

### 🎬 メディア操作モード

ブラウザ上の video / audio 要素や一部サービスの再生ボタンを操作します。

- ▶⏸ 再生 / 一時停止
- ▶ 再生
- ⏸ 一時停止
- 🔊🔉 音量アップ / ダウン
- 🔇 ミュート
- ⏩⏪ 10秒進む / 10秒戻る
- ⏭⏮ 次のトラック / 前のトラック
- ⏫⏬ 再生速度アップ / ダウン
- 1× 再生速度リセット

### 🌐 ブラウザ操作モード

ページやタブをハンドサインで操作します。

- ↕ 保持してスクロール: サインを出したまま手を上下左右に動かしてスクロール
- ↑↓←→ 上 / 下 / 左 / 右スクロール
- ⇡⇣⇠⇢ カーソル上 / 下 / 左 / 右
- ↟↡ ページ先頭 / ページ末尾
- ↩↪ 戻る / 進む
- ⇥⇤ 次のタブ / 前のタブ
- ↻ 再読み込み
- ＋− ズームイン / ズームアウト
- 100% 等倍に戻す

ブラウザ操作モードの初期割り当てでは、OK サインが「保持してスクロール」に割り当てられています。カーソル移動4種はアクションとして選択できますが、初期状態ではどのサインにも割り当てられていません。

### 🔀 操作モード

NyandSign には「メディア操作」と「ブラウザ操作」の2つの操作モードがあります。サイドパネル上部のモード切り替えボタン、または両手サインで切り替えられます。

モードを切り替えると、使用するハンドサイン設定も同時に切り替わります。メディア操作用の割り当てとブラウザ操作用の割り当てを分けて保存できます。

### 🙌 両手サイン

両手サインには、通常の片手ハンドサインとは別に機能を割り当てられます。

| 両手サイン | 初期機能 |
|---|---|
| 🖼️ フレーム | ⏻ 操作 ON/OFF |
| ✌️✌️ 両ピース | ⇄ メディア操作 / ブラウザ操作の切り替え |
| ✌️ + ✊ ピース + グー | — なし |

両手サインは一度発火すると、サインを解除するまで同じ機能を繰り返し発火しません。

### 📌 PiP モード

フルスクリーン再生時にサイドパネルが邪魔になる場合、コンパクトな PiP ポップアップに切り替えられます。

PiP では現在の状態を枠色で判別できます。

- ⏻ 操作 OFF: 赤
- 🎬 メディア操作モード: 緑
- 🌐 ブラウザ操作モード: 青

### 🎯 操作対象タブ

操作対象はアクティブタブのほか、特定のタブに固定できます。BGM を再生しているタブを固定し、別のページを見ながらメディア操作する、といった使い方ができます。

### 🔒 プライバシー

カメラ映像とハンドトラッキング処理はすべてローカルで完結します。

- ☁️ クラウド処理なし
- 📷 カメラ映像の外部送信なし
- 👤 アカウント登録不要
- ⚙️ 設定は Chrome storage に保存

## 👓 対応デバイス

| デバイス | カメラ |
|---|---|
| XREAL One Pro / One / 1S（Eye アクセサリ使用） | ✅ 対応 |
| Nreal Light | ✅ 対応 |
| XREAL Air / Air 2 / Air 2 Pro | ❌ カメラ非搭載 |
| 通常のウェブカメラ | ✅ 対応 |

XREAL 等の電気メガネのカメラを有効化するには、外部サービス [EyeCon](https://megane.8796.jp/eyecon/) を使用します。

## 📦 インストール

Chrome Web Store からインストールするか、開発者モードでローカルインストールできます。

ローカルインストール:

1. `chrome://extensions/` を開く
2. 「デベロッパーモード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択

## 🚀 使い方

1. ツールバーの拡張アイコンをクリックしてサイドパネルを開く
2. カメラを選択して「カメラ開始」をクリック
3. 初回はブラウザのカメラ権限ダイアログを許可
4. 操作モードを選ぶ
5. ウェイクサインを出してから、割り当て済みのハンドサインを出す

デフォルトでは、パーで起動してからサイン操作を受け付けます。ウェイクサインは設定で変更できます。常時アクティブにすることもできます。

## 🛠️ 開発

ビルドシステムはありません。HTML / CSS / JavaScript を直接編集し、Chrome の拡張機能管理画面で読み込みます。

変更の反映:

- `manifest.json` / `src/background/service-worker.js` を変更した場合: 拡張機能を再読み込み
- `src/sidepanel/sidepanel.js` / `src/content/content-script.js` を変更した場合: サイドパネルを開き直す、または対象タブをリロード
- `src/tracking/hand-tracker.js` を変更した場合: サイドパネルまたは PiP を再起動

リリース用アーカイブは `pack.ps1` で作成します。

## 🗂️ ファイル構成

```text
nyandsign-chrome/
├── manifest.json        # Chrome 拡張マニフェスト (Manifest V3)
├── src/
│   ├── shared/
│   │   ├── constants.js         # アクション・デフォルト設定・モード定義
│   │   ├── camera-runtime.js    # カメラストリーム取得・接続・解放の共有処理
│   │   └── gesture-runtime.js   # サイドパネル / PiP で共有するジェスチャー実行補助
│   ├── background/
│   │   └── service-worker.js    # メッセージルーティング・タブ操作・単一インスタンス制御
│   ├── content/
│   │   └── content-script.js    # ページ内のメディア操作・スクロール・キーイベント補助
│   ├── sidepanel/
│   │   ├── sidepanel.html       # サイドパネル UI
│   │   ├── sidepanel.css        # サイドパネルと PiP のスタイル
│   │   └── sidepanel.js         # メイン UI・設定・カメラ管理・チュートリアル
│   ├── pip/
│   │   ├── pip.html             # PiP ポップアップ
│   │   └── pip.js               # PiP 側のカメラ管理・ジェスチャー実行
│   ├── tracking/
│   │   └── hand-tracker.js      # MediaPipe HandLandmarker ラッパーとサイン判定
│   └── camera/
│       ├── camera-setup.html    # カメラ権限取得ページ
│       └── camera-setup.js      # カメラ権限取得処理
├── lib/mediapipe/       # MediaPipe Vision (vendored)
├── _locales/            # i18n メッセージ (ja / en)
├── icons/               # 拡張アイコン
└── docs/                # ストア掲載文などの補助ドキュメント
```

## 🏗️ アーキテクチャ

```text
カメラ
  ↓
HandTracker (src/tracking/hand-tracker.js)
  ↓ gesture イベント
src/sidepanel/sidepanel.js / src/pip/pip.js
  ↓ src/shared/gesture-runtime.js + src/shared/camera-runtime.js + src/shared/constants.js
chrome.runtime.sendMessage
  ↓
src/background/service-worker.js
  ↓
src/content/content-script.js / chrome.tabs API
  ↓
メディア要素・ページ・タブを操作
```

サイドパネルと PiP はそれぞれ独立してカメラと HandTracker を起動します。複数ウィンドウでカメラ認識が競合しないよう、`src/background/service-worker.js` が単一インスタンス制御を行います。

## 📄 サードパーティライセンス

### MediaPipe Vision (@mediapipe/tasks-vision)

- ライセンス: Apache License 2.0
- 著作権: Copyright Google LLC
- ソース: https://github.com/google-ai-edge/mediapipe
- 配置先: `lib/mediapipe/`

MediaPipe Vision の WASM ランタイム・JS バンドル・HandLandmarker モデルを `lib/mediapipe/` に vendored（同梱）しています。Apache License 2.0 に基づき再配布が許可されています。ライセンス全文は `lib/mediapipe/LICENSE` を参照してください。

## ⚠️ 免責事項

本プロジェクトは XREAL およびその関連企業とは無関係であり、推奨・後援を受けるものではありません。XREAL、Nreal およびその関連商標は、それぞれの所有者に帰属します。

デバイス通信機能は、観測されたデバイスの動作および公開されている識別子（USB VID/PID 等）に基づき独自に開発されたものです。XREAL / Nreal のソースコード、ファームウェア、プロプライエタリなバイナリは一切含まれていません。

## ⚖️ ライセンス

[MIT License](LICENSE)
