[CmdletBinding()]
param([string]$InstallRoot)
$ErrorActionPreference = 'Stop'
if (-not $InstallRoot) { $InstallRoot = $PSScriptRoot }
$root = [IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $root 'common.ps1')
if ((Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $root 'installation.json') | ConvertFrom-Json).product -ne 'feng-chrome-mcp') { throw '这不是 SaltedFish 安装目录。' }
# 与 install.ps1、uninstall.ps1 共用的安装级互斥；占用时在这里直接失败，不会走到下面的 catch（它会停服务、改版本指针）。
$installLock = Enter-InstallLock $root
try {
$current = (Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $root 'active-version.txt')).Trim()
$previous = (Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $root 'previous-version.txt')).Trim()
foreach ($version in @($current,$previous)) { if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw '版本号无效。' } }
$currentRelease = Join-Path $root "versions\$current\release.json"
$currentMeta = $null
if (Test-Path -LiteralPath $currentRelease) { $currentMeta = Get-Content -Encoding UTF8 -Raw -LiteralPath $currentRelease | ConvertFrom-Json }
$previousMeta = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $root "versions\$previous\release.json") | ConvertFrom-Json
if ($currentMeta -and $currentMeta.stateVersion -gt $previousMeta.stateVersion) { throw '旧版本不支持当前数据结构。为保留未知操作和已撤销凭据，拒绝自动恢复历史数据库。' }
# 当前版本残缺（缺 node.exe 或 cli.js，例如被中断的卸载）时，它的运行时不可用或不可信：改用旧版本自带的运行时做同一个只读的数据格式核查。
$currentRunnable = Test-ProgramRunnable $root $current
$inspectionVersion = $current
if (-not (Test-Path -LiteralPath (Join-Path $root "versions\$current\runtime\node.exe") -PathType Leaf)) { $inspectionVersion = $previous }
Assert-StateCompatible $root $inspectionVersion ([int]$previousMeta.stateVersion)
$launcher = Get-InstalledLauncher $root
$maintenance = Join-Path $root 'data\maintenance'
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($maintenance,'rollback',$utf8)
$env:CHROME_MCP_INSTALLING = '1'
try {
    # 残缺的当前版本无法用启动器执行 stop，也不可能有它启动的服务；直接切到旧版本。
    if ($currentRunnable) { & $launcher stop; if ($LASTEXITCODE -ne 0) { throw '当前服务未能停止。' } }
    else { Write-Warning "当前版本 $current 的程序文件不完整，跳过停止服务，直接切换到 $previous。" }
    Assert-StateCompatible $root $inspectionVersion ([int]$previousMeta.stateVersion)
    Unregister-SaltedFishDesktop (Join-Path $root 'data')
    $next = Join-Path $root 'active-version.next'
    [IO.File]::WriteAllText($next,$previous,$utf8)
    $backup = Join-Path $root ('active-version.'+[Guid]::NewGuid().ToString('N')+'.bak')
    [IO.File]::Replace($next,(Join-Path $root 'active-version.txt'),$backup)
    [IO.File]::Delete($backup)
    Remove-ExtensionExtras (Join-Path $root 'data\extension') (Join-Path $root "versions\$previous\dist\extension")
    & $launcher setup; if ($LASTEXITCODE -ne 0) { throw '旧版本启动失败。' }
    Register-SaltedFishDesktopIfSupported $root $previous $launcher
    [IO.File]::WriteAllText((Join-Path $root 'previous-version.txt'),$current,$utf8)
    Write-Output "已回滚到 $previous，数据和已撤销授权保持当前状态。"
} catch {
    try { & $launcher stop } catch {}
    [IO.File]::WriteAllText((Join-Path $root 'active-version.txt'),$current,$utf8)
    try { & $launcher setup; Register-SaltedFishDesktopIfSupported $root $current $launcher } catch {}
    throw
} finally {
    Remove-Item -LiteralPath $maintenance -Force -ErrorAction SilentlyContinue
    Remove-Item Env:CHROME_MCP_INSTALLING -ErrorAction SilentlyContinue
}
} finally { Exit-InstallLock $installLock }
