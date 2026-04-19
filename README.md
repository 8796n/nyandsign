# NyandSign — Hand Sign Media Controller

Detect hand signs via your webcam and control media playback hands-free — play, pause, volume, seek, and more with simple gestures.

ウェブカメラでハンドサインを検出し、メディア再生をハンズフリーで操作する Chrome 拡張機能です。

---

## 概要

NyandSign は Google MediaPipe のオンデバイス AI を使い、リアルタイムでハンドサインを検出してメディア再生操作にマッピングします。すべての処理はブラウザ内でローカルに完結し、データが外部サーバーに送信されることは一切ありません。

YouTube、Spotify、Netflix など、あらゆるブラウザメディアをハンドサインで操作できます。電気メガネ（XREAL 等の AR スマートグラス）のカメラとの組み合わせで、メガネをかけたまま直感的にメディアを制御することを主な用途として設計されています。

## 主な機能

**🖐️ 8種類のハンドサイン認識**
グー、ピース、OK、アロハ（シャカ）、右指差し、左指差し、サムズアップ、サムズダウン

**🎬 メディア操作の全機能**
再生 / 一時停止 / 音量アップ / 音量ダウン / ミュート / 10秒シーク / 次のトラック / 前のトラック

**⚡ 高いカスタマイズ性**
ジェスチャーとアクションの自由なマッピング変更、誤操作防止のウェイクサインモード、両手サインによるON/OFFトグル

**📌 PiP（ピクチャーインピクチャー）モード**
フルスクリーン再生時にサイドパネルが邪魔になる場合、コンパクトなポップアップウィンドウに切り替え可能。コンテンツを遮ることなくハンドサイン操作を継続できます。

**🎯 ターゲットタブ指定**
他のページを閲覧しながら、BGMを再生している特定タブを操作できます。

**🔒 完全ローカル処理・プライバシー保護**
カメラ映像がブラウザの外に出ることはありません。クラウド処理なし、データ収集なし、アカウント登録不要。

**🌐 日英バイリンガル対応**

## 対応デバイス

| デバイス | カメラ |
|---|---|
| XREAL One Pro / One / 1S（Eye アクセサリ使用） | ✅ |
| Nreal Light | ✅ |
| XREAL Air / Air 2 / Air 2 Pro | ❌ カメラ非搭載 |
| 通常のウェブカメラ | ✅ |

XREAL 等の電気メガネのカメラを有効化するには、外部サービス [EyeCon](https://megane.8796.jp/eyecon/) を使用します。

## インストール

Chrome Web Store からインストールするか、開発者モードでローカルインストールできます。

**ローカルインストール（開発者モード）:**
1. `chrome://extensions/` を開く
2. 「デベロッパーモード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択

## 使い方

1. ツールバーの拡張アイコンをクリック → サイドパネルが開く
2. カメラを選択して「▶ カメラ開始」をクリック
3. 初回はブラウザのカメラ権限ダイアログを許可
4. ハンドトラッキングが開始され、ハンドサインでメディア操作が可能に

**ウェイクサインについて:**
誤操作を防ぐため、デフォルトでは🖐️ open（手を開く）でウェイクしてからコマンドを受け付けます。ウェイクサインはサイドパネルで変更できます。

## ファイル構成

```
nyandsign/
├── manifest.json        # Chrome 拡張マニフェスト (Manifest V3)
├── service-worker.js    # バックグラウンド: サインアクション転送
├── content-script.js    # メディア操作 (全タブに注入)
├── sidepanel.html/js    # サイドパネル UI・制御ロジック
├── sidepanel.css        # スタイル
├── pip.html/js          # PiP ポップアップウィンドウ
├── hand-tracker.js      # MediaPipe HandLandmarker ラッパー + ハンドサイン検出
├── camera-setup.html/js # カメラ選択セットアップページ
├── lib/mediapipe/       # MediaPipe Vision (vendored)
│   ├── vision_bundle.mjs
│   ├── wasm/            # WASM ランタイム
│   └── models/          # hand_landmarker.task モデル
└── icons/               # 拡張アイコン
```

## サードパーティライセンス

### MediaPipe Vision (@mediapipe/tasks-vision)

- **ライセンス**: Apache License 2.0
- **著作権**: Copyright Google LLC
- **ソース**: https://github.com/google-ai-edge/mediapipe
- **配置先**: `lib/mediapipe/`

MediaPipe Vision の WASM ランタイム・JS バンドル・HandLandmarker モデルを `lib/mediapipe/` に vendored（同梱）しています。Apache License 2.0 に基づき再配布が許可されています。ライセンス全文は `lib/mediapipe/LICENSE` を参照してください。

## 免責事項

本プロジェクトは XREAL およびその関連企業とは無関係であり、推奨・後援を受けるものではありません。XREAL、Nreal およびその関連商標は、それぞれの所有者に帰属します。

デバイス通信機能は、観測されたデバイスの動作および公開されている識別子（USB VID/PID 等）に基づき独自に開発されたものです。XREAL / Nreal のソースコード、ファームウェア、プロプライエタリなバイナリは一切含まれていません。

## ライセンス

[MIT License](LICENSE)
