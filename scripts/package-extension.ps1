[CmdletBinding()]
# 默认打 dist\extension。-Store 打 Chrome 应用商店版（dist\extension-store，先运行 node scripts/build-extension.mjs --store），里面没有一键更新。
# -FromPackage 从已冻结的 npm 包（.tgz）里取 dist/extension 打包、不重新构建：GitHub Release 挂的是这份，和 npm 上的扩展逐文件一致。
param([switch]$Store,[string]$FromPackage)
$ErrorActionPreference = 'Stop'
if ($Store -and $FromPackage) { throw '-Store 和 -FromPackage 不能同时用：npm 包里没有商店版。' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'packaging\common.ps1')
$staging = $null
try {
    if ($FromPackage) {
        $tgz = [IO.Path]::GetFullPath($FromPackage)
        if (-not (Test-Path -LiteralPath $tgz -PathType Leaf)) { throw ('找不到 npm 包：' + $tgz) }
        $staging = Join-Path ([IO.Path]::GetTempPath()) ('saltedfish-extension-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging | Out-Null
        # 用系统自带的 tar，不按裸名查找：Git Bash 的 PATH 里是另一个 tar。
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $tgz -C $staging package/package.json package/dist/extension
        if ($LASTEXITCODE -ne 0) { throw 'npm 包解压失败。' }
        $package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $staging 'package\package.json') | ConvertFrom-Json
        $source = Join-Path $staging 'package\dist\extension'
        $target = Join-Path $repo ('release\saltedfish-extension-'+$package.version+'.zip')
    } else {
        $package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json
        if ($Store) {
            $source = Join-Path $repo 'dist\extension-store'
            $target = Join-Path $repo ('release\saltedfish-extension-store-'+$package.version+'.zip')
        } else {
            $source = Join-Path $repo 'dist\extension'
            $target = Join-Path $repo ('release\saltedfish-extension-'+$package.version+'.zip')
        }
    }
    $source = (Get-Item -LiteralPath $source).FullName
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
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $files = @(Get-ChildItem -LiteralPath $source -Recurse -File | Sort-Object FullName)
    try {
        # 不用 ZipFile.CreateFromDirectory：.NET Framework 写的子目录条目名用反斜杠（_locales\en\...），Chrome 认不出。
        $zip = [IO.Compression.ZipFile]::Open($target, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in $files) {
                $name = $file.FullName.Substring($source.Length).TrimStart('\').Replace('\','/')
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
            }
        } finally { $zip.Dispose() }
        # 读回 ZIP，逐个条目和源文件比对。
        $read = [IO.Compression.ZipFile]::OpenRead($target)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            if ($read.Entries.Count -ne $files.Count) { throw 'ZIP 条目数和扩展文件数不一致。' }
            foreach ($file in $files) {
                $name = $file.FullName.Substring($source.Length).TrimStart('\').Replace('\','/')
                $entry = $read.GetEntry($name)
                if (-not $entry) { throw ('ZIP 里缺少 ' + $name) }
                $stream = $entry.Open()
                try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose() }
                if ($actual -ne (Get-Sha256 $file.FullName)) { throw ('ZIP 里的 ' + $name + ' 和源文件不一致。') }
            }
        } finally { $algorithm.Dispose(); $read.Dispose() }
    } catch {
        # 开头已确认目标不存在，这里删的只是本次写出的 ZIP。
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        throw
    }
    $hash = Get-Sha256 $target
    [IO.File]::WriteAllText(($target+'.sha256'),($hash+'  '+[IO.Path]::GetFileName($target)+"`n"),[Text.UTF8Encoding]::new($false))
    Write-Output ($target + ' SHA256 ' + $hash)
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
