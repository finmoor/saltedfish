[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param([string]$InstallRoot)
$ErrorActionPreference = 'Stop'
if (-not $InstallRoot) { $InstallRoot = $PSScriptRoot }
$root = [IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $root 'common.ps1')
if ((Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $root 'installation.json') | ConvertFrom-Json).product -ne 'feng-chrome-mcp') { throw '不是 SaltedFish 安装目录，未删除任何文件。' }
$utf8 = [Text.UTF8Encoding]::new($false)
# 与 install.ps1、rollback.ps1 共用的安装级互斥；占用时在这里直接失败，不动任何文件。
$installLock = Enter-InstallLock $root
try {
# 阶段一：动手之前先看有没有 AI 客户端仍连着。它们的 MCP 子进程占用 runtime\node.exe 和启动器，Windows 不允许删除；
# 硬删会在 node.exe 处失败，而此时 dist、node_modules 已被删光，安装目录成了启动器、卸载和重装都不能恢复的空壳。
$clients = @(Get-InstallProcesses $root | Where-Object { -not (Test-ServiceProcess $_) })
if ($clients.Count -gt 0) { throw (Format-InstallUsers $root $clients @() '卸载') }
if (-not $PSCmdlet.ShouldProcess($root,'卸载 SaltedFish 程序，保留 data 中的配置、授权和结果文件')) { return }
$active = Get-ActiveVersion $root
$launcher = Get-InstalledLauncher $root
$versions = Assert-Child (Join-Path $root 'versions') $root
$maintenance = Join-Path $root 'data\maintenance'
$marked = Test-Path -LiteralPath (Join-Path $root 'data') -PathType Container
$hadProgram = (Test-Path -LiteralPath $versions) -or (Test-Path -LiteralPath $launcher) -or (Test-Path -LiteralPath (Join-Path $root 'active-version.txt'))
if ($marked) { [IO.File]::WriteAllText($maintenance,'uninstall',$utf8) }
try {
    # 启动器或该版本的 node.exe、cli.js 缺失时（上次卸载或安装被中断）无法执行 stop，服务也不可能由它运行；改由下面的占用检查兜底。
    if (Test-ProgramRunnable $root $active) {
        & $launcher stop
        if ($LASTEXITCODE -ne 0) { throw '服务未停止，未删除程序文件。' }
    }
    # 阶段二：服务刚停止，等它的进程退出；此时仍有进程或被锁住的 exe（例如停止期间新启动的客户端）照样拒绝。
    $idle = Wait-InstallIdle $root 10
    if ($idle.Processes.Count -gt 0 -or $idle.Files.Count -gt 0) { throw (Format-InstallUsers $root $idle.Processes $idle.Files '卸载') }
    Unregister-SaltedFishDesktop (Join-Path $root 'data') -ValidateOnly
    if (Test-Path -LiteralPath $versions) {
        # 把 versions 整个改名移走是提交点：改名要么整体成功，要么什么都不变（目录或其中文件被占用时失败），不会留下删一半的版本目录。
        $trash = Assert-Child (Join-Path $root ('.uninstall-' + [Guid]::NewGuid().ToString('N'))) $root
        $moveError = $null
        for ($attempt = 1; $attempt -le 4; $attempt++) {
            try { [IO.Directory]::Move($versions,$trash); $moveError = $null; break }
            catch { $moveError = $(if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }); Start-Sleep -Milliseconds 400 }
        }
        if ($moveError) { throw "无法移走程序目录 ${versions}：有程序正在使用其中的文件，或终端、资源管理器的当前目录位于其中。请关闭它们后重新运行卸载，未删除任何文件。（系统提示：$moveError）" }
    }
} catch {
    # 提交之前失败：恢复成未卸载的状态，客户端可以继续连接。
    if ($marked) { [IO.File]::Delete($maintenance) }
    throw
}
# 提交之后不再回退。成功后保留维护标记，避免尚未退出的客户端重新启动已卸载程序，重装会覆盖它；
# 下面任何一步失败，重新运行卸载即可补完（脚本对残缺的安装是幂等的）。
Unregister-SaltedFishDesktop (Join-Path $root 'data')
foreach ($name in @('SaltedFish.exe','FengChromeMCP.exe','active-version.txt','previous-version.txt','rollback.ps1')) {
    $target = Assert-Child (Join-Path $root $name) $root
    $failure = Remove-WithRetry $target
    if ($failure) { throw "程序目录已移走，但无法删除 ${target}：$failure 请关闭仍在使用它的程序后重新运行 uninstall.ps1 补完。" }
}
foreach ($leftover in @(Clear-InstallLeftovers $root)) { Write-Warning "无法删除临时目录 ${leftover}（可能仍被占用），可稍后手动删除；不影响重新安装。" }
if ($hadProgram) { Write-Output "程序已卸载，数据保留在 $(Join-Path $root 'data')。请在 Chrome 中移除扩展，并移除客户端中的 saltedfish 配置。" }
else { Write-Output "没有发现可卸载的程序文件，数据保留在 $(Join-Path $root 'data')。" }
} finally { Exit-InstallLock $installLock }
