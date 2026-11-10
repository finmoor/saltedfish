[CmdletBinding()]
param([string]$InstallRoot, [int]$Port = 17422, [switch]$NoStart, [switch]$NoOnboarding)
$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
. (Join-Path $packageRoot 'common.ps1')
if (-not $InstallRoot) {
    $InstallRoot = Get-DefaultInstallRoot $env:LOCALAPPDATA
    $rootNote = Get-DefaultInstallRootNote $env:LOCALAPPDATA $InstallRoot
    if ($rootNote) { Write-Output $rootNote }
}
$installPath = [IO.Path]::GetFullPath($InstallRoot)
$utf8 = [Text.UTF8Encoding]::new($false)
function Save-Active([string]$Version) {
    $target = Join-Path $installPath 'active-version.txt'
    $temp = Join-Path $installPath 'active-version.next'
    [IO.File]::WriteAllText($temp,$Version,$utf8)
    if (Test-Path -LiteralPath $target) {
        $backup = $target + '.' + [Guid]::NewGuid().ToString('N') + '.bak'
        [IO.File]::Replace($temp,$target,$backup)
        [IO.File]::Delete($backup)
    } else { [IO.File]::Move($temp,$target) }
}
# 与 rollback.ps1、uninstall.ps1 共用的安装级互斥，覆盖预检、暂存、切换和失败恢复；占用时在这里直接失败，不会走到下面的 catch。
$installLock = Enter-InstallLock $installPath
try {
$manifest = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $packageRoot 'checksums.json') | ConvertFrom-Json
if ($manifest.product -ne 'feng-chrome-mcp' -or $manifest.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw '安装包标识无效。' }
foreach ($item in $manifest.files) {
    $source = Assert-Child (Join-Path $packageRoot $item.path) $packageRoot
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少安装文件：$($item.path)" }
    if ((Get-Sha256 $source) -ne $item.sha256) { throw "安装包校验失败：$($item.path)" }
}
if (Test-Path -LiteralPath $installPath) {
    $marker = Join-Path $installPath 'installation.json'
    if ((Get-ChildItem -Force -LiteralPath $installPath | Measure-Object).Count -gt 0 -and -not (Test-Path -LiteralPath $marker)) { throw (Get-InstallRootConflictMessage $installPath) }
    if (Test-Path -LiteralPath $marker) {
        $markedProduct = (Get-Content -Encoding UTF8 -Raw -LiteralPath $marker | ConvertFrom-Json).product
        if ($markedProduct -ne 'feng-chrome-mcp') { throw "目标目录 ${installPath} 属于其他产品（installation.json 标记为 ${markedProduct}）；未覆盖任何文件。npm 版 SaltedFish 的数据目录也属于这种情况，请换一个目录，用 install.ps1 -InstallRoot <目录> 指定。" }
    }
}
New-Item -ItemType Directory -Path $installPath -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $installPath 'installation.json'),'{"product":"feng-chrome-mcp"}',$utf8)
$dataPath = Join-Path $installPath 'data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$dataAcl = [Security.AccessControl.DirectorySecurity]::new()
$dataAcl.SetAccessRuleProtection($true,$false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $dataAcl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($dataPath,$dataAcl)
$maintenance = Join-Path $dataPath 'maintenance'
[IO.File]::WriteAllText($maintenance,'install',$utf8)
$previous = Get-ActiveVersion $installPath
$previousLauncher = Get-InstalledLauncher $installPath
$launcher = Join-Path $installPath 'SaltedFish.exe'
$env:CHROME_MCP_INSTALLING = '1'
$keepMaintenance = $false
try {
    if ($previous) {
        if (Test-ProgramRunnable $installPath $previous) { & $previousLauncher stop; if ($LASTEXITCODE -ne 0) { throw '旧服务未能正常停止，安装中止。' } }
        # 上次卸载或升级被中断时程序文件可能残缺，启动器无法执行 stop；这种安装不可能有它启动的服务，下面会补全文件。
        else { Write-Warning "已安装的 $previous 程序文件不完整（可能是上次卸载或升级被中断），无法用它停止旧服务；本次安装会补全缺失的文件。" }
    }
    foreach ($leftover in @(Clear-InstallLeftovers $installPath)) { Write-Warning "无法删除上次遗留的临时目录 ${leftover}，可稍后手动删除。" }
    $versionPath = Assert-Child (Join-Path $installPath ('versions\' + $manifest.version)) $installPath
    $packageHash = Get-Sha256 (Join-Path $packageRoot 'checksums.json')
    if (Test-Path -LiteralPath $versionPath) {
        $hashFile = Join-Path $versionPath 'package.hash'
        $recordedHash = ''
        if (Test-Path -LiteralPath $hashFile -PathType Leaf) { $recordedHash = [IO.File]::ReadAllText($hashFile).Trim() }
        if ($recordedHash -and $recordedHash -ne $packageHash) { throw '同一版本的文件内容不同，禁止覆盖不可变版本。请使用新的版本号。' }
        # package.hash 一致只说明来自同一个安装包，不说明文件齐全：被中断的卸载会留下缺 dist、node_modules 的半成品。按清单逐个核对，补全缺失或损坏的文件。
        $problems = @(Get-VersionFileProblems $versionPath $packageRoot $manifest)
        if ($problems.Count -gt 0) { Write-Output "已安装的 $($manifest.version) 有 $($problems.Count) 个文件缺失或损坏（例如 $($problems[0].Relative)），用本安装包补全。" }
        foreach ($problem in $problems) {
            try {
                New-Item -ItemType Directory -Path (Split-Path -Parent $problem.Target) -Force | Out-Null
                Copy-Item -LiteralPath $problem.Source -Destination $problem.Target -Force
            } catch { throw "无法补全 $($problem.Relative)（$($problem.Reason)）：$($_.Exception.Message) 如有 AI 客户端仍连着 SaltedFish，请先关闭后重新运行安装器。" }
        }
        if ($problems.Count -gt 0 -or -not $recordedHash) {
            [IO.File]::WriteAllText($hashFile,$packageHash,$utf8)
            $unrepaired = @(Get-VersionFileProblems $versionPath $packageRoot $manifest)
            if ($unrepaired.Count -gt 0) { throw "补全后仍有 $($unrepaired.Count) 个文件与安装包不一致（例如 $($unrepaired[0].Relative)），安装中止。" }
        }
    } else {
        $staging = Assert-Child (Join-Path $installPath ('.staging\' + [Guid]::NewGuid().ToString('N'))) $installPath
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $packageRoot 'payload') -Destination (Join-Path $staging 'app') -Recurse
        [IO.File]::WriteAllText((Join-Path $staging 'app\package.hash'),$packageHash,$utf8)
        New-Item -ItemType Directory -Path (Split-Path $versionPath) -Force | Out-Null
        $sourcePath = Assert-Child (Join-Path $staging 'app') $installPath
        Move-Item -LiteralPath $sourcePath -Destination $versionPath
    }
    if (-not (Test-Path -LiteralPath $launcher)) { Copy-Item -LiteralPath (Join-Path $packageRoot 'SaltedFish.exe') -Destination $launcher }
    $legacyLauncher = Join-Path $installPath 'FengChromeMCP.exe'
    if (-not (Test-Path -LiteralPath $legacyLauncher)) { Copy-Item -LiteralPath (Join-Path $packageRoot 'SaltedFish.exe') -Destination $legacyLauncher }
    Copy-Item -LiteralPath (Join-Path $packageRoot 'rollback.ps1') -Destination (Join-Path $installPath 'rollback.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $packageRoot 'common.ps1') -Destination (Join-Path $installPath 'common.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $packageRoot 'uninstall.ps1') -Destination (Join-Path $installPath 'uninstall.ps1') -Force
    if ($previous -and $previous -ne $manifest.version) { [IO.File]::WriteAllText((Join-Path $installPath 'previous-version.txt'),$previous,$utf8) }
    Save-Active $manifest.version
    if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'config.json'))) {
        $selectedPort = $Port
        while ($true) {
            $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$selectedPort)
            try { $probe.Start(); $probe.Stop(); break } catch { $probe.Stop(); $selectedPort++; if ($selectedPort -gt $Port + 100) { throw '未找到可用本地端口。' } }
        }
        $env:CHROME_MCP_PORT = [string]$selectedPort
    }
    & $launcher setup
    if ($LASTEXITCODE -ne 0) { throw '新版本初始化失败。' }
    Register-SaltedFishDesktopIfSupported $installPath $manifest.version $launcher
    if ($NoStart) { & $launcher stop; if ($LASTEXITCODE -ne 0) { throw '安装成功，但服务未能停止。' } }
    Write-Output "安装完成：$launcher"
    Write-Output "Chrome 扩展目录：$(Join-Path $dataPath 'extension')"
    Write-Output '本安装包没有产品代码签名；校验用于发现文件损坏，不代替发行者身份验证。'
} catch {
    $failure = $_
    if (Test-Path -LiteralPath $launcher) { try { & $launcher stop } catch {} }
    $recoveryLauncher = Get-InstalledLauncher $installPath
    if ($previous -and (Test-Path -LiteralPath $recoveryLauncher) -and (Test-Path -LiteralPath (Join-Path $installPath "versions\$previous\release.json"))) {
        $previousMeta = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $installPath "versions\$previous\release.json") | ConvertFrom-Json
        $inspectionVersion = $manifest.version
        if (-not (Test-Path -LiteralPath (Join-Path $installPath "versions\$inspectionVersion\runtime\node.exe"))) { $inspectionVersion = $previous }
        try { Assert-StateCompatible $installPath $inspectionVersion ([int]$previousMeta.stateVersion) }
        catch { $keepMaintenance = $true; throw "新版本初始化失败，数据已不能安全退回旧版；保留当前版本及维护记录，请修复当前版或安装兼容更新。$($_.Exception.Message)" }
        try { Unregister-SaltedFishDesktop $dataPath } catch { Write-Warning '桌面入口已有改动，保持原样；继续恢复原程序版本。' }
        Save-Active $previous
        # 启动常驻服务时不能把原生命令接到 Out-Null：PS5 会等待后台进程持有的输出管道。
        try { & $recoveryLauncher setup; Register-SaltedFishDesktopIfSupported $installPath $previous $recoveryLauncher } catch {}
    }
    throw $failure
} finally {
    if (-not $keepMaintenance) { Remove-Item -LiteralPath $maintenance -Force -ErrorAction SilentlyContinue }
    Remove-Item Env:CHROME_MCP_INSTALLING -ErrorAction SilentlyContinue
    Remove-Item Env:CHROME_MCP_PORT -ErrorAction SilentlyContinue
}

if (-not $NoStart -and -not $NoOnboarding) {
    & $launcher dashboard --onboarding
    if ($LASTEXITCODE -ne 0) { Write-Warning "接入向导未能打开，请运行 SaltedFish.exe dashboard。安装已完成。" }
}
} finally { Exit-InstallLock $installLock }
