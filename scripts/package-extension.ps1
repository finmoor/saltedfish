[CmdletBinding()]
# -Store 打 Chrome 应用商店版（dist\extension-store，先运行 node scripts/build-extension.mjs --store），里面没有一键更新。
param([switch]$Store)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json
if ($Store) {
    $source = Join-Path $repo 'dist\extension-store'
    $target = Join-Path $repo ('release\saltedfish-extension-store-'+$package.version+'.zip')
} else {
    $source = Join-Path $repo 'dist\extension'
    $target = Join-Path $repo ('release\saltedfish-extension-'+$package.version+'.zip')
}
if (Test-Path -LiteralPath $target) { throw '已有同版本扩展 ZIP，禁止覆盖。' }
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $source 'manifest.json') | ConvertFrom-Json
if ($manifest.version_name -ne $package.version -or $manifest.name -ne 'SaltedFish') { throw '扩展构建版本或品牌不一致。' }
# 0.3.19 起服务和扩展同一个版本号
if (-not $package.version.Contains('-') -and $manifest.version -ne $package.version) { throw '扩展的 version 要和 package.json 相同。' }
$pairing = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $source 'pairing.json') | ConvertFrom-Json
if ($pairing.token) { throw '扩展分发包不能包含配对密钥。' }
if ($Store) {
    foreach ($file in @('background.js','options.js')) {
        $code = [IO.File]::ReadAllText((Join-Path $source $file))
        foreach ($word in @('showDirectoryPicker','createWritable')) { if ($code.Contains($word)) { throw ('商店版里还有一键更新的代码：' + $file) } }
    }
}
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'release') | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($source,$target,[IO.Compression.CompressionLevel]::Optimal,$false)
. (Join-Path $repo 'packaging\common.ps1')
$hash = Get-Sha256 $target
[IO.File]::WriteAllText(($target+'.sha256'),($hash+'  '+[IO.Path]::GetFileName($target)+"`n"),[Text.UTF8Encoding]::new($false))
Write-Output ($target + ' SHA256 ' + $hash)
