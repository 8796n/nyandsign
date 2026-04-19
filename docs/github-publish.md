# GitHub 公開リポジトリへの反映手順

## 方針

- **GitHub（https://github.com/8796n/nyandsign）が正史**
- ローカルの `main` ブランチで開発し、任意のタイミングで push する
- 過去の開発履歴は公開しない（GitHub は v1.0.37 からスタート）
- ローカルの `master` ブランチはアーカイブとして残す（触らない）
- `docs/` および `.github/copilot-instructions.md` は GitHub に公開しない（`.gitignore` で除外済み）

## 日常の開発フロー

```powershell
# main ブランチで作業・コミットを続ける
git checkout main

# ... 開発・コミット ...

# 任意のタイミングで GitHub に反映
git push origin main
```

これだけ。外部からPRが来た場合は GitHub 上でマージするだけ、その後 `git pull` でローカルに取り込む。

## 外部PRが来た場合

```powershell
git checkout main
git pull origin main   # GitHub でマージされた変更を取り込む
```

## 反映タイミングの目安

- Chrome Web Store に新バージョンを提出するとき
- README や公開情報を大きく更新したとき
- 機能追加・バグ修正がある程度まとまったとき

細かいコミットのたびに push する必要はない。

## ブランチ構成

| ブランチ | 用途 |
|---|---|
| `main` | 開発・GitHub公開用（こちらを使う） |
| `master` | 過去の開発履歴アーカイブ（触らない） |
