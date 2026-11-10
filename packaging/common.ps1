function Get-Sha256([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Assert-Child([string]$Path, [string]$Root) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside installation: $resolved" }
    return $resolved
}

function Test-NativeRoot([string]$Path) {
    $marker = Join-Path $Path 'installation.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
    try { return ((Get-Content -Encoding UTF8 -Raw -LiteralPath $marker | ConvertFrom-Json).product -eq 'feng-chrome-mcp') } catch { return $false }
}

# npm 版默认把数据放在 %LOCALAPPDATA%\SaltedFish\npm；目录里只有这个 npm 子目录时，它是 npm 的容器，不是原生安装。
function Test-NpmOnlyDirectory([string]$Path) {
    $entries = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
    return ($entries.Count -eq 1 -and $entries[0].PSIsContainer -and $entries[0].Name -eq 'npm')
}

function Get-DefaultInstallRoot([string]$BaseDirectory) {
    $preferred = Join-Path $BaseDirectory 'SaltedFish'
    # 已有原生安装一律沿用，不搬动用户数据和已加载扩展的路径：新名称优先，其次旧 FengChromeMCP，最后是下面冲突时改用的目录。
    $legacy = Join-Path $BaseDirectory 'FengChromeMCP'
    $alternate = Join-Path $BaseDirectory 'SaltedFish-native'
    foreach ($candidate in @($preferred,$legacy,$alternate)) { if (Test-NativeRoot $candidate) { return $candidate } }
    # 全新安装。先装了 npm 版时 SaltedFish 目录已存在且只有 npm 子目录，直接用它会被安装器的“目录非空且不是 SaltedFish 安装”保护拒绝。
    if ((Test-Path -LiteralPath $preferred) -and (Test-NpmOnlyDirectory $preferred)) { return $alternate }
    return $preferred
}

# 全新安装因 npm 版占用了默认目录而改用别处时返回说明文字（已有原生安装只是被沿用，不算改用），否则返回 $null。
function Get-DefaultInstallRootNote([string]$BaseDirectory, [string]$Chosen) {
    $preferred = Join-Path $BaseDirectory 'SaltedFish'
    if ($Chosen -eq (Join-Path $BaseDirectory 'SaltedFish-native') -and -not (Test-NativeRoot $Chosen) -and (Test-Path -LiteralPath $preferred) -and -not (Test-NativeRoot $preferred) -and (Test-NpmOnlyDirectory $preferred)) {
        return "默认目录 ${preferred} 已存在，里面只有 npm 安装的数据目录（npm 子目录）；原生安装不能与它共用，改装到 ${Chosen}。以后重新运行本安装包会自动找到这个目录；也可以用 -InstallRoot 指定其他位置。"
    }
    return $null
}

function Get-InstalledLauncher([string]$Root) {
    $preferred = Join-Path $Root 'SaltedFish.exe'
    if (Test-Path -LiteralPath $preferred) { return $preferred }
    return (Join-Path $Root 'FengChromeMCP.exe')
}

function Assert-StateCompatible([string]$Root, [string]$RuntimeVersion, [int]$SupportedVersion) {
    $database = Join-Path $Root 'data\state.sqlite'
    if (-not (Test-Path -LiteralPath $database)) { return }
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw '任务数据库路径无效，未切换版本。' }
    if ($RuntimeVersion -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$' -or $SupportedVersion -lt 1) { throw '数据兼容性参数无效。' }
    $runtime = Assert-Child (Join-Path $Root "versions\$RuntimeVersion\runtime\node.exe") $Root
    if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw '缺少只读数据核查运行时，未回滚任务数据库。' }
    # 只读 SQLite 格式标记；不初始化服务、不修改数据库或恢复旧数据备份。
    $probe = 'const{DatabaseSync}=require(''node:sqlite'');const db=new DatabaseSync(process.argv[1],{readOnly:true});let v;try{db.exec(''PRAGMA query_only=ON'');v=db.prepare(''PRAGMA user_version'').get().user_version;}finally{db.close();}if(!Number.isSafeInteger(v)||v>Number(process.argv[2])){console.error(''当前任务数据库需要更高版本；请修复当前版或安装兼容更新，不回滚任务数据库。'');process.exitCode=2;}'
    & $runtime -e $probe $database ([string]$SupportedVersion)
    if ($LASTEXITCODE -ne 0) { throw '当前数据不能由目标版本读取；保留当前版本和维护记录，请修复当前版或安装兼容更新。' }
}

# ---- 安装目录占用检测、半成品清理与版本目录核对（卸载、同版本重装共用）----
function Get-ActiveVersion([string]$Root) {
    $file = Join-Path $Root 'active-version.txt'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    $text = [IO.File]::ReadAllText($file).Trim()
    if ($text -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { return $text }
    return $null
}

# 启动器与该版本的 node.exe、cli.js 都在才算能运行；缺任何一个，启动器都无法执行 stop 等命令。
function Test-ProgramRunnable([string]$Root, [string]$Version) {
    if (-not $Version) { return $false }
    foreach ($path in @((Get-InstalledLauncher $Root),(Join-Path $Root "versions\$Version\runtime\node.exe"),(Join-Path $Root "versions\$Version\dist\cli.js"))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    }
    return $true
}

# 镜像路径位于安装目录之下的进程：SaltedFish.exe 启动器，以及 runtime\node.exe（后台服务和 AI 客户端启动的 MCP 子进程）。
function Get-InstallProcesses([string]$Root) {
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)
    $byId = @{}
    foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }
    foreach ($item in $all) {
        if (-not $item.ExecutablePath -or -not $item.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { continue }
        $parent = $byId[[int]$item.ParentProcessId]
        # 父进程号可能已被系统回收复用；创建时间晚于子进程的不是真正的父进程。
        if ($parent -and $item.CreationDate -and $parent.CreationDate -gt $item.CreationDate) { $parent = $null }
        [pscustomobject]@{
            ProcessId = [int]$item.ProcessId; Name = [string]$item.Name; Path = [string]$item.ExecutablePath; CommandLine = [string]$item.CommandLine
            ParentId = [int]$item.ParentProcessId; ParentName = $(if ($parent) { [string]$parent.Name } else { '' })
        }
    }
}

# 后台服务（cli.js serve）会被 stop 正常停掉，不算需要用户关闭的客户端。
function Test-ServiceProcess($Process) {
    return ([string]$Process.CommandLine) -match '(?i)(cli\.js|\.exe)"?\s+"?serve"?(\s|$)'
}

function Test-FileInUse([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    # 独占读写打开：正在运行的 exe 因映像映射而共享冲突，普通文件打开后立即释放。
    try { $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $stream.Dispose(); return $false }
    catch [IO.IOException] { return $true }
    catch { return $false }
}

# 可能正在运行的可执行文件：两个启动器，以及每个版本的 runtime\node.exe。
function Get-LockedInstallFiles([string]$Root) {
    $candidates = @((Join-Path $Root 'SaltedFish.exe'),(Join-Path $Root 'FengChromeMCP.exe'))
    $versions = Join-Path $Root 'versions'
    if (Test-Path -LiteralPath $versions -PathType Container) {
        foreach ($directory in @(Get-ChildItem -LiteralPath $versions -Directory -Force)) { $candidates += (Join-Path $directory.FullName 'runtime\node.exe') }
    }
    return @($candidates | Where-Object { Test-FileInUse $_ })
}

# 等刚停止的服务进程退出后，再确认没有进程或锁留在安装目录；已有客户端（非服务）进程时不必等待。
function Wait-InstallIdle([string]$Root, [int]$Seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ($true) {
        $processes = @(Get-InstallProcesses $Root)
        $files = @(Get-LockedInstallFiles $Root)
        $clients = @($processes | Where-Object { -not (Test-ServiceProcess $_) })
        if (($processes.Count -eq 0 -and $files.Count -eq 0) -or $clients.Count -gt 0 -or [DateTime]::UtcNow -ge $deadline) { return [pscustomobject]@{ Processes = $processes; Files = $files } }
        Start-Sleep -Milliseconds 250
    }
}

function Format-InstallUsers([string]$Root, $Processes, $Files, [string]$Action) {
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("无法${Action}：安装目录 ${Root} 仍被以下程序使用。")
    foreach ($item in $Processes) {
        $text = "  - $($item.Name)（PID $($item.ProcessId)）"
        if (Test-ServiceProcess $item) { $text += '，SaltedFish 后台服务，停止后仍未退出' }
        elseif ($item.ParentName) { $text += "，由 $($item.ParentName)（PID $($item.ParentId)）启动" }
        $lines.Add($text)
    }
    foreach ($file in $Files) { $lines.Add("  - 文件被占用：${file}（看不到持有它的进程，可能是以其他权限运行的程序）") }
    $lines.Add('请先关闭仍连着 SaltedFish MCP 的 AI 客户端（Codex、OpenCode、Claude 等，或在客户端里停用 saltedfish），以及当前目录位于安装目录下的终端窗口，然后重新运行。未删除任何文件。')
    return ($lines -join [Environment]::NewLine)
}

# 删除文件或目录；被杀毒软件、索引服务或刚退出的进程短暂占用时重试。成功返回 $null，失败返回最后一次的错误信息。
function Remove-WithRetry([string]$Path, [switch]$Recurse) {
    $message = ''
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        try {
            if ($Recurse) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop } else { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
            return $null
        } catch { $message = $_.Exception.Message; Start-Sleep -Milliseconds (300 * $attempt) }
    }
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return $message
}

# 清理卸载或安装中断留下的临时目录（.uninstall-* 是卸载时移走的程序目录，.staging 是安装暂存区）；返回未能删除的路径。
function Clear-InstallLeftovers([string]$Root) {
    $failed = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)) {
        if (-not $item.PSIsContainer -or ($item.Name -notlike '.uninstall-*' -and $item.Name -ne '.staging')) { continue }
        $path = Assert-Child $item.FullName $Root
        if (Remove-WithRetry $path -Recurse) { $failed += $path }
    }
    return $failed
}

# 对照安装包的 checksums.json 核对已安装的版本目录，返回缺失或内容不一致的文件（元素含 Relative、Target、Source、Reason）。
function Get-VersionFileProblems([string]$VersionPath, [string]$PackageRoot, $Manifest) {
    foreach ($item in $Manifest.files) {
        $entry = [string]$item.path
        if (-not $entry.StartsWith('payload/',[StringComparison]::Ordinal)) { continue }
        $relative = $entry.Substring(8).Replace('/','\')
        $target = Assert-Child (Join-Path $VersionPath $relative) $VersionPath
        $reason = $null
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { $reason = '缺失' }
        else {
            try { if ((Get-Sha256 $target) -ne $item.sha256) { $reason = '内容与安装包不一致' } }
            catch { $reason = '无法读取' }
        }
        if ($reason) { [pscustomobject]@{ Relative = $relative; Target = $target; Source = (Join-Path $PackageRoot $entry.Replace('/','\')); Reason = $reason } }
    }
}

# 目标目录非空又没有原生安装标记时给 install.ps1 的说明。
function Get-InstallRootConflictMessage([string]$Path) {
    $text = "目标目录 ${Path} 非空，且不是 SaltedFish 原生安装；未覆盖任何文件。"
    if (Test-Path -LiteralPath (Join-Path $Path 'npm\installation.json')) { $text += '其中有 npm 版 SaltedFish 的数据目录（npm 子目录），原生安装与 npm 安装不能共用一个目录。' }
    return $text + '请换一个空目录或尚不存在的目录，在 PowerShell 中运行 install.ps1 -InstallRoot <目录>。'
}

# 只供 scripts/package-windows.ps1 和 test-package.ps1 使用：packaging 目录（安装脚本、启动器源码、README 模板）的指纹。
# scripts/release-evidence.mjs 的源码指纹只含其中的 npm-README.md，而这些文件正是 Windows 安装包的内容，验收记录也要绑定它们。
function Get-PackagingFingerprint([string]$Repo) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Repo 'packaging') -File | Sort-Object Name)) {
            $name = [Text.Encoding]::UTF8.GetBytes($file.Name + [char]0)
            [void]$algorithm.TransformBlock($name,0,$name.Length,$null,0)
            $bytes = [IO.File]::ReadAllBytes($file.FullName)
            [void]$algorithm.TransformBlock($bytes,0,$bytes.Length,$null,0)
            $separator = [byte[]]@(0)
            [void]$algorithm.TransformBlock($separator,0,1,$null,0)
        }
        [void]$algorithm.TransformFinalBlock([byte[]]@(),0,0)
        return [BitConverter]::ToString($algorithm.Hash).Replace('-','').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

# 不依赖当前版本的 Node/CLI：卸载或回滚时程序可能已经残缺。只移除完整匹配本安装记录的协议入口。
function Unregister-SaltedFishDesktopCore([string]$DataDirectory,[switch]$ValidateOnly) {
    $data = [IO.Path]::GetFullPath($DataDirectory)
    $directory = Join-Path $data 'desktop'
    $recordPath = Join-Path $directory 'registration.json'
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return }
    $recordText = [IO.File]::ReadAllText($recordPath,[Text.Encoding]::UTF8)
    $saved = $recordText | ConvertFrom-Json
    if ($saved.product -ne 'saltedfish-desktop' -or $saved.schemaVersion -ne 1 -or [IO.Path]::GetFullPath($saved.dataDir) -ine $data -or $saved.port -lt 1024 -or $saved.port -gt 65535) { throw '桌面入口记录不属于此安装，未删除。' }
    if ($saved.registryRoot -ne 'HKCU\Software\Classes' -and $saved.registryRoot -notmatch '^HKCU\\Software\\SaltedFish\\Tests\\Desktop_[a-f0-9]{32}$') { throw '桌面入口注册位置无效，未删除。' }
    $runner = Join-Path $directory 'SaltedFish.Settings.exe'
    $descriptor = Join-Path $directory 'settings-launch.json'
    $fullKey = $saved.registryRoot + '\saltedfish-' + $saved.port
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $mutexHash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($fullKey))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
    $mutex = [Threading.Mutex]::new($false,('Local\SaltedFishDesktop_'+$mutexHash)); $taken=$false
    try {
    try { $taken=$mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $taken=$true }
    if (-not $taken) { throw '桌面入口正在更新，请稍后重试。' }
    if ([IO.File]::ReadAllText($recordPath,[Text.Encoding]::UTF8) -cne $recordText) { throw '桌面入口记录在注销前发生变化，未删除。' }
    foreach ($item in @(@{path=$runner;hash=$saved.runnerSha256},@{path=$descriptor;hash=$saved.descriptorSha256})) {
        if ((Test-Path -LiteralPath $item.path -PathType Leaf) -and (Get-Sha256 $item.path) -ne $item.hash) { throw '桌面启动文件已被修改，未删除。' }
    }
    $relative = $saved.registryRoot.Substring(5) + '\saltedfish-' + $saved.port
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative)
    try {
        if ($key) {
            $names = @($key.GetValueNames() | Sort-Object -CaseSensitive)
            if (($names -join '|') -cne '|SaltedFishInstallation|URL Protocol' -or ($key.GetSubKeyNames() -join '|') -cne 'shell' -or $key.GetValue('') -cne 'URL:SaltedFish settings' -or $key.GetValue('SaltedFishInstallation') -cne $data -or $key.GetValue('URL Protocol') -cne '') { throw '桌面入口已被其他程序修改，未删除。' }
            foreach ($name in $names) { if ($key.GetValueKind($name).ToString() -ne 'String') { throw '桌面入口类型已变化，未删除。' } }
            $shell = $key.OpenSubKey('shell'); $open = $key.OpenSubKey('shell\open'); $command = $key.OpenSubKey('shell\open\command')
            try {
                if (-not $shell -or -not $open -or -not $command -or $shell.ValueCount -ne 0 -or ($shell.GetSubKeyNames() -join '|') -cne 'open' -or $open.ValueCount -ne 0 -or ($open.GetSubKeyNames() -join '|') -cne 'command' -or $command.SubKeyCount -ne 0 -or $command.ValueCount -ne 1 -or ($command.GetValueNames() -join '|') -ne '' -or $command.GetValueKind('').ToString() -ne 'String' -or $command.GetValue('') -cne ('"'+$runner+'" "%1"')) { throw '桌面启动命令已被修改，未删除。' }
            } finally { if($command){$command.Dispose()};if($open){$open.Dispose()};if($shell){$shell.Dispose()} }
        }
    } finally { if($key){$key.Dispose()} }
    if ($ValidateOnly) { return }
    # 路径限定为已验证的 HKCU 产品键；不枚举或删除其他安装的注册项。
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($relative,$false)
    foreach ($file in @($runner,$descriptor,$recordPath)) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
    } finally { if($taken){$mutex.ReleaseMutex()};$mutex.Dispose() }
}

# 旧版本的 setup 只覆盖不删。新版多出来的文件留着，扩展目录指纹就和旧版对不上，设置入口登记不上。
function Remove-ExtensionExtras([string]$Directory,[string]$Release) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container) -or -not (Test-Path -LiteralPath $Release -PathType Container)) { return }
    $kept = @(Get-ChildItem -LiteralPath $Release -Force | ForEach-Object { $_.Name })
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($kept -notcontains $item.Name) { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
    }
}

function Register-SaltedFishDesktopIfSupported([string]$InstallPath,[string]$Version,[string]$Launcher) {
    if (Test-Path -LiteralPath (Join-Path $InstallPath "versions\$Version\dist\desktop-registration.js")) {
        & $Launcher desktop register
        if ($LASTEXITCODE -ne 0) { Write-Warning '桌面设置入口未注册；现有管理页登录方式仍可使用。请核查本机同端口的其他安装或被修改的注册项。' }
        $global:LASTEXITCODE=0
    }
}

# 不依赖已安装 Node；先验证两个入口，再删除自身项。原扩展授权快照随 data 保留供回滚后再升级。
function Unregister-SaltedFishDesktop([string]$DataDirectory,[switch]$ValidateOnly) {
    Unregister-SaltedFishNativeSettings $DataDirectory -ValidateOnly
    Unregister-SaltedFishDesktopCore $DataDirectory -ValidateOnly
    if (-not $ValidateOnly) {
        Unregister-SaltedFishNativeSettings $DataDirectory
        Unregister-SaltedFishDesktopCore $DataDirectory
    }
}

function Unregister-SaltedFishNativeSettings([string]$DataDirectory,[switch]$ValidateOnly) {
    $data = [IO.Path]::GetFullPath($DataDirectory)
    $directory = Join-Path $data 'native-settings'
    $recordPath = Join-Path $directory 'registration.json'
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return }
    $recordText = [IO.File]::ReadAllText($recordPath,[Text.Encoding]::UTF8)
    $saved = $recordText | ConvertFrom-Json
    if ($saved.product -ne 'saltedfish-native-settings' -or $saved.schemaVersion -ne 1 -or [IO.Path]::GetFullPath($saved.dataDir) -ine $data -or $saved.port -lt 1024 -or $saved.port -gt 65535) { throw '本机通信入口记录不属于此安装，未删除。' }
    if ($saved.registryRoot -ne 'HKCU\Software\Google\Chrome\NativeMessagingHosts' -and $saved.registryRoot -notmatch '^HKCU\\Software\\SaltedFish\\Tests\\Native_[a-f0-9]{32}$') { throw '本机通信注册位置无效，未删除。' }
    $runner = Join-Path $directory 'SaltedFish.NativeSettings.exe'
    $descriptor = Join-Path $directory 'native-launch.json'
    $manifestPath = Join-Path $directory 'host.json'
    $fullKey = $saved.registryRoot + '\com.saltedfish.settings.p' + $saved.port
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $mutexHash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($fullKey))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
    $mutex = [Threading.Mutex]::new($false,('Local\SaltedFishDesktop_'+$mutexHash)); $taken=$false
    try {
        try { $taken=$mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $taken=$true }
        if (-not $taken) { throw '本机通信入口正在更新，请稍后重试。' }
        if ([IO.File]::ReadAllText($recordPath,[Text.Encoding]::UTF8) -cne $recordText) { throw '本机通信记录在注销前发生变化，未删除。' }
        $previous = @{}
        foreach ($item in @(@{path=$runner;hash=$saved.runnerSha256},@{path=$descriptor;hash=$saved.descriptorSha256},@{path=$manifestPath;hash=$saved.manifestSha256})) {
            if ($item.hash -notmatch '^[a-f0-9]{64}$') { throw '本机通信记录校验值无效，未删除。' }
            if (Test-Path -LiteralPath $item.path -PathType Leaf) {
                if ((Get-Sha256 $item.path) -ne $item.hash) { throw '本机通信文件已被修改，未删除。' }
                $previous[$item.path] = [IO.File]::ReadAllBytes($item.path)
            }
        }
        $relative = $fullKey.Substring(5)
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative)
        $hadKey = $null -ne $key
        try {
            if ($key) {
                $names = @($key.GetValueNames() | Sort-Object -CaseSensitive)
                if (($names -join '|') -cne '|SaltedFishInstallation' -or $key.SubKeyCount -ne 0 -or $key.GetValue('') -cne $manifestPath -or $key.GetValue('SaltedFishInstallation') -cne $data) { throw '本机通信入口已被其他程序修改，未删除。' }
                foreach ($name in $names) { if ($key.GetValueKind($name).ToString() -ne 'String') { throw '本机通信入口类型已变化，未删除。' } }
            }
        } finally { if($key){$key.Dispose()} }
        if ($ValidateOnly) { return }
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($relative,$false)
        try { foreach ($file in @($runner,$descriptor,$manifestPath)) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } } }
        catch {
            foreach ($file in $previous.Keys) { if (-not (Test-Path -LiteralPath $file)) { [IO.File]::WriteAllBytes($file,$previous[$file]) } }
            if ($hadKey) {
                $current = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative)
                if ($current) { $current.Dispose() }
                else {
                    $restored = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($relative)
                    try { $restored.SetValue('',$manifestPath,[Microsoft.Win32.RegistryValueKind]::String); $restored.SetValue('SaltedFishInstallation',$data,[Microsoft.Win32.RegistryValueKind]::String) } finally { $restored.Dispose() }
                }
            }
            throw
        }
    } finally { if($taken){$mutex.ReleaseMutex()};$mutex.Dispose() }
}

# 原生安装、回滚、卸载共用的安装级互斥：按规范化后的安装根目录取同一个命名互斥，占用时立即拒绝（不等待、不清理别人的暂存区、不进入各脚本的失败恢复）。
# 互斥随持有进程退出自动释放；持有者异常退出留下的 Abandoned 状态视为可以接手，各脚本本来就能收拾遗留的 .staging 和维护标记。
function Enter-InstallLock([string]$Root) {
    $normalized = [IO.Path]::GetFullPath($Root).TrimEnd('\').ToLowerInvariant()
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $lockHash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
    $mutex = $null; $taken = $false
    try {
        $mutex = [Threading.Mutex]::new($false,('Global\SaltedFishInstall_'+$lockHash))
        try { $taken = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taken = $true }
    } catch [UnauthorizedAccessException] {
        if ($mutex) { $mutex.Dispose() }
        throw '安装锁正被其他账户的安装、回滚或卸载占用，请等它结束后再试；本次没有改动任何文件。'
    }
    if (-not $taken) {
        $mutex.Dispose()
        throw "另一个 SaltedFish 安装、回滚或卸载正在操作 ${Root}，请等它结束后再试；本次没有改动任何文件，也没有停止服务。"
    }
    return $mutex
}

function Exit-InstallLock($Mutex) {
    if (-not $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch {}
    $Mutex.Dispose()
}
