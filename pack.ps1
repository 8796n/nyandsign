# Chrome Web Store 公開用 ZIP パッケージ作成スクリプト
# 使い方: pwsh pack.ps1
# 出力: nyand-sign-vX.Y.Z.zip

$ErrorActionPreference = 'Stop'

# manifest.json からバージョンを取得
$manifest = Get-Content -Raw -Path "$PSScriptRoot\manifest.json" | ConvertFrom-Json
$version = $manifest.version
$outName = "nyand-sign-v${version}.zip"
$outPath = Join-Path $PSScriptRoot $outName

# 既存の ZIP があれば削除
if (Test-Path $outPath) { Remove-Item $outPath }

# 含めるファイル・ディレクトリ一覧
$includes = @(
    'manifest.json'
    '_locales'
    'camera-setup.html'
    'camera-setup.js'
    'constants.js'
    'content-script.js'
    'hand-tracker.js'
    'icons'
    'lib'
    'pip.html'
    'pip.js'
    'service-worker.js'
    'sidepanel.css'
    'sidepanel.html'
    'sidepanel.js'
)

# 一時ディレクトリにコピーして ZIP 化
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "nyand-sign-pack-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
    foreach ($item in $includes) {
        $src = Join-Path $PSScriptRoot $item
        if (-not (Test-Path $src)) {
            Write-Warning "スキップ（存在しない）: $item"
            continue
        }
        $dest = Join-Path $tempDir $item
        if (Test-Path $src -PathType Container) {
            Copy-Item -Path $src -Destination $dest -Recurse
        } else {
            $parentDir = Split-Path $dest -Parent
            if (-not (Test-Path $parentDir)) {
                New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
            }
            Copy-Item -Path $src -Destination $dest
        }
    }

    # ZIP 作成
    Compress-Archive -Path "$tempDir\*" -DestinationPath $outPath -CompressionLevel Optimal
    $size = [math]::Round((Get-Item $outPath).Length / 1KB, 1)
    Write-Host "✅ $outName ($($size) KB) を作成しました" -ForegroundColor Green
} finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
