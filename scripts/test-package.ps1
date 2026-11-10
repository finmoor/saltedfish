[CmdletBinding()]
param([string]$LegacyPackage)
$ErrorActionPreference = 'Stop'
# PowerShell 5 按 [Console]::OutputEncoding 解码原生命令的输出，中文系统上是 CP936，而启动器输出 UTF-8：
# doctor 里的中文说明会被当成 GBK 拆字，句末的「。」把后面那个引号一并吃掉，ConvertFrom-Json 随即报字符串未闭合。
# 只改本进程的解码方式，不动系统代码页；改不动时不拦截，后面的断言照样会失败。
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { Write-Verbose "未能切换控制台输出编码：$($_.Exception.Message)" }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'packaging\common.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$package = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $repo '.local\last-package.json') | ConvertFrom-Json
$testBase = Join-Path $repo '.local\package-tests'
$testRoot = Join-Path $testBase ([Guid]::NewGuid().ToString('N'))
$extracted = Join-Path $testRoot 'package'
$installed = Join-Path $testRoot '安装目录 with spaces'
$upgrade = Join-Path $testRoot 'upgrade'
$node = (Get-Command node.exe).Source
$checks = [Collections.Generic.List[string]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)
function Passed([string]$Name) { $checks.Add($Name); Write-Output "PASS $Name" }
# 合成的下一版要比当前新、格式合法：0.3.0-beta.N 后面接 .upgrade-test；0.3.19 这种接不了，改成下一个补丁号的预发布（0.3.20-upgrade-test）。
function Get-LaterVersion([string]$Version, [string]$Label) {
  if ($Version.Contains('-')) { return $Version + '.' + $Label }
  $parts = $Version.Split('.')
  return $parts[0] + '.' + $parts[1] + '.' + ([int]$parts[2] + 1) + '-' + $Label
}
function Run-Installer([string]$PackagePath, [string]$TargetPath) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PackagePath 'install.ps1') -InstallRoot $TargetPath -Port 18422 -NoOnboarding
    if ($LASTEXITCODE -ne 0) { throw 'Installer returned an error.' }
}
function Run-FailingInstaller([string]$PackagePath, [string]$TargetPath) {
    # PowerShell 5 的 2>&1 捕获会等待后台服务继承的管道。用独立隐藏进程并限制等待时间。
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $PackagePath 'install.ps1')+'"'),'-NoOnboarding','-InstallRoot',('"'+$TargetPath+'"'))
    $testProcess = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $testProcess.WaitForExit(45000)) {
        $testProcess.Kill()
        throw 'Expected-failure installer did not exit within 45 seconds.'
    }
    $exitCode = $testProcess.ExitCode
    $testProcess.Dispose()
    return $exitCode
}
# 与 package-windows.ps1 相同的源码指纹（scripts/release-evidence.mjs，npm 候选包也用它）：验收记录绑定到构建这个包的那份源码。
function Get-SourceFingerprint([string]$NodePath) {
    $probe = "import { sourceFingerprint } from './scripts/release-evidence.mjs'; console.log(await sourceFingerprint(process.cwd()))"
    Push-Location -LiteralPath $repo
    try { $value = (& $NodePath --input-type=module -e $probe | Out-String).Trim() } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or $value -notmatch '^[a-f0-9]{64}$') { throw 'Cannot compute the source fingerprint.' }
    return $value
}
# 模拟 Codex/OpenCode/Claude 启动的 MCP 子进程：stdin 保持打开，启动器和 node.exe 一直占用安装目录。
function Start-McpClient([string]$LauncherPath) {
    $info = [Diagnostics.ProcessStartInfo]::new($LauncherPath,'mcp')
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $client = [Diagnostics.Process]::Start($info)
    $client.BeginOutputReadLine(); $client.BeginErrorReadLine()
    return $client
}
function Stop-McpClient($Client) {
    if (-not $Client) { return }
    try { $Client.StandardInput.Close() } catch {}
    if (-not $Client.WaitForExit(15000)) { try { $Client.Kill() } catch {} }
    $Client.Dispose()
    Start-Sleep -Milliseconds 800
}
function Wait-InstallProcess([string]$Root, [string]$Pattern) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (@(Get-InstallProcesses $Root | Where-Object { $_.CommandLine -match $Pattern }).Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}
function Run-Uninstaller([string]$TargetPath, [string]$OutputFile) {
    # 独立隐藏进程并限制等待时间；-File 无法传 -Confirm:$false，所以用 -Command。输出写文件，不接管道。
    $command = "try { & '" + (Join-Path $TargetPath 'uninstall.ps1') + "' -InstallRoot '" + $TargetPath + "' -Confirm:`$false } catch { Write-Output ('ERROR: ' + `$_.Exception.Message); exit 1 }; exit 0"
    $testProcess = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',('"'+$command+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput $OutputFile
    $null = $testProcess.Handle
    if (-not $testProcess.WaitForExit(90000)) {
        $testProcess.Kill()
        throw 'Uninstaller did not exit within 90 seconds.'
    }
    $exitCode = $testProcess.ExitCode
    $testProcess.Dispose()
    if ($null -eq $exitCode) { throw 'Could not read the uninstaller exit code.' }
    return [int]$exitCode
}
function New-MarkedDirectory([string]$Path, [string]$Product) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $Path 'installation.json'),('{"product":"'+$Product+'"}'),$utf8)
}
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$launcher = Join-Path $installed 'SaltedFish.exe'
$legacyRoot = Join-Path $testRoot 'legacy-localappdata\FengChromeMCP'
$legacyLauncher = Join-Path $legacyRoot 'FengChromeMCP.exe'
$previousDesktopTestRoot = $env:SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT
$desktopTestRoot = 'HKCU\Software\SaltedFish\Tests\Desktop_' + [Guid]::NewGuid().ToString('N')
$env:SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT = $desktopTestRoot
$previousNativeTestRoot = $env:SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT
$nativeTestRoot = 'HKCU\Software\SaltedFish\Tests\Native_' + [Guid]::NewGuid().ToString('N')
$env:SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT = $nativeTestRoot
function Get-ProductionDesktopSnapshot {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes')
    if (-not $key) { return '[]' }
    try { $items=@($key.GetSubKeyNames() | Where-Object { $_ -match '^saltedfish-[0-9]+$' } | Sort-Object | ForEach-Object {
        $item=$key.OpenSubKey($_);$command=$item.OpenSubKey('shell\open\command')
        try { [ordered]@{name=$_;owner=$item.GetValue('SaltedFishInstallation');command=$(if($command){$command.GetValue('')})} } finally { if($command){$command.Dispose()};$item.Dispose() }
    }); return (ConvertTo-Json -InputObject $items -Compress -Depth 4) } finally { $key.Dispose() }
}
$desktopBefore = Get-ProductionDesktopSnapshot
function Get-ProductionNativeSnapshot {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts')
    if (-not $key) { return '[]' }
    try { $items=@($key.GetSubKeyNames() | Where-Object { $_ -match '^com\.saltedfish\.settings\.p[0-9]+$' } | Sort-Object | ForEach-Object {
        $item=$key.OpenSubKey($_)
        try { [ordered]@{name=$_;owner=$item.GetValue('SaltedFishInstallation');manifest=$item.GetValue('')} } finally { $item.Dispose() }
    }); return (ConvertTo-Json -InputObject $items -Compress -Depth 4) } finally { $key.Dispose() }
}
function Assert-NativeSettings([string]$InstallPath,[bool]$Enabled=$true,[string]$ExtraDirectory='') {
    $data=Join-Path $InstallPath 'data'
    $config=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $data 'config.json') | ConvertFrom-Json
    $folder=Join-Path $data 'native-settings'
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($nativeTestRoot.Substring(5)+'\com.saltedfish.settings.p'+$config.port)
    try {
        if (-not $Enabled) { if($key -or (Test-Path -LiteralPath (Join-Path $folder 'host.json'))){throw 'Removed native settings host is still registered.'}; return }
        $saved=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $folder 'registration.json') | ConvertFrom-Json
        $manifest=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $folder 'host.json') | ConvertFrom-Json
        if(-not $key -or $key.GetValue('') -cne (Join-Path $folder 'host.json') -or $saved.registryRoot -cne $nativeTestRoot -or $saved.entry.command -cne (Join-Path $InstallPath 'SaltedFish.exe') -or @($saved.entry.args).Count -ne 0){throw 'Native messaging settings entry differs from this isolated installation.'}
        if($manifest.path -cne (Join-Path $folder 'SaltedFish.NativeSettings.exe') -or @($manifest.allowed_origins).Count -lt 1){throw 'Native messaging host manifest has invalid launcher or origins.'}
        if($ExtraDirectory -and -not (@($saved.extensions | Where-Object {$_.directory -ceq $ExtraDirectory}).Count -eq 1)){throw 'Upgrade or rollback lost the trusted original extension directory.'}
        foreach($item in @(@{name='SaltedFish.NativeSettings.exe';hash=$saved.runnerSha256},@{name='native-launch.json';hash=$saved.descriptorSha256},@{name='host.json';hash=$saved.manifestSha256})){if((Get-Sha256 (Join-Path $folder $item.name)) -cne $item.hash){throw 'Native messaging installed file checksum differs from its record.'}}
    } finally {if($key){$key.Dispose()}}
}
$nativeBefore = Get-ProductionNativeSnapshot
try {
    $packageHash = Get-Sha256 $package.zip
    if ($packageHash -ne $package.sha256) { throw 'ZIP checksum does not match the build record.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($package.zip,$extracted)
    $pairing = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $extracted 'payload\dist\extension\pairing.json') | ConvertFrom-Json
    if ($pairing.token) { throw 'The package contains a pairing credential.' }
    foreach ($forbidden in @('data','.local','config.json')) {
        if (Test-Path -LiteralPath (Join-Path $extracted ('payload\'+$forbidden))) { throw "Unexpected local state in package: $forbidden" }
    }
    # 记录绑定源码：打包之后源码或测试若又变了，这份验收记录就不再说明这个包。
    if (-not $package.sourceFingerprint) { throw 'last-package.json has no sourceFingerprint: rebuild with the current scripts/package-windows.ps1.' }
    if ($package.sourceFingerprint -ne (Get-SourceFingerprint $node)) { throw 'Source or tests changed after the package was built: rebuild the package before accepting it.' }
    # packaging 下的安装脚本和启动器源码不在源码指纹里，单独绑定。
    if (-not $package.packagingFingerprint -or $package.packagingFingerprint -ne (Get-PackagingFingerprint $repo)) { throw 'The installer scripts or launcher source changed after the package was built (or last-package.json has no packagingFingerprint): rebuild the package before accepting it.' }
    # 包内帮助：与 npm 包同一个检查（链接可达、变量已渲染、安装命令版本不过时），并且只带随包帮助白名单里的文档。
    $payloadRoot = Join-Path $extracted 'payload'
    $docsProbe = "import { checkPackagedDocs, packagedDocs } from './scripts/release-docs.mjs'; await checkPackagedDocs(process.argv[1]); console.log(packagedDocs.join(String.fromCharCode(10)))"
    Push-Location -LiteralPath $repo
    try { $whitelist = @(& $node --input-type=module -e $docsProbe $payloadRoot | Where-Object { $_ }) } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or $whitelist.Count -lt 1) { throw 'Packaged help is broken: unreachable links, unrendered variables, or a stale install command.' }
    $docsDirectory = Join-Path $payloadRoot 'docs'
    $shippedDocs = @(Get-ChildItem -LiteralPath $docsDirectory -Recurse -File | ForEach-Object { 'docs/' + $_.FullName.Substring($docsDirectory.Length + 1).Replace('\','/') } | Sort-Object)
    if (($shippedDocs -join "`n") -ne (@($whitelist | Sort-Object) -join "`n")) { throw ('The package ships documents outside the packaged-help whitelist: ' + ($shippedDocs -join ', ')) }
    Passed 'Windows 包内帮助链接与版本可达，只带随包帮助白名单文档'
    $isolatedAppData = Join-Path $testRoot 'legacy-localappdata'
    if ((Get-DefaultInstallRoot $isolatedAppData) -ne (Join-Path $isolatedAppData 'SaltedFish')) { throw 'New installations must use SaltedFish.' }
    # 先装了 npm 版时 SaltedFish 目录已存在、里面只有 npm 子目录：默认目录不能再选它，否则安装器会因目录非空且不是原生安装而失败。
    $npmFirst = Join-Path $testRoot 'npm-first-localappdata'
    New-MarkedDirectory (Join-Path $npmFirst 'SaltedFish\npm') 'saltedfish-npm'
    if ((Get-DefaultInstallRoot $npmFirst) -ne (Join-Path $npmFirst 'SaltedFish-native') -or -not (Get-DefaultInstallRootNote $npmFirst (Get-DefaultInstallRoot $npmFirst))) { throw 'npm-first machine did not get a conflict-free default with an explanation.' }
    New-MarkedDirectory (Join-Path $npmFirst 'SaltedFish-native') 'feng-chrome-mcp'
    if ((Get-DefaultInstallRoot $npmFirst) -ne (Join-Path $npmFirst 'SaltedFish-native') -or (Get-DefaultInstallRootNote $npmFirst (Get-DefaultInstallRoot $npmFirst))) { throw 'An existing alternate native install was not reused quietly.' }
    $legacyBeside = Join-Path $testRoot 'legacy-beside-npm'
    New-MarkedDirectory (Join-Path $legacyBeside 'SaltedFish\npm') 'saltedfish-npm'
    New-MarkedDirectory (Join-Path $legacyBeside 'FengChromeMCP') 'feng-chrome-mcp'
    if ((Get-DefaultInstallRoot $legacyBeside) -ne (Join-Path $legacyBeside 'FengChromeMCP')) { throw 'An npm home beside a legacy native install hid the legacy install.' }
    $nativeFirst = Join-Path $testRoot 'native-first-localappdata'
    New-MarkedDirectory (Join-Path $nativeFirst 'SaltedFish') 'feng-chrome-mcp'
    New-MarkedDirectory (Join-Path $nativeFirst 'SaltedFish\npm') 'saltedfish-npm'
    if ((Get-DefaultInstallRoot $nativeFirst) -ne (Join-Path $nativeFirst 'SaltedFish')) { throw 'A native install that contains an npm home must stay the default.' }
    Passed '默认安装目录与 npm 版共存：冲突时改用 SaltedFish-native，已有安装不被绕开'
    Run-Installer $extracted $installed
    $version = (& $launcher version | ConvertFrom-Json).version
    if ($version -ne $package.version) { throw 'Installed version does not match.' }
    $desktopRecord = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installed 'data\desktop\registration.json') | ConvertFrom-Json
    if ($desktopRecord.registryRoot -cne $desktopTestRoot -or $desktopRecord.entry.command -cne $launcher -or @($desktopRecord.entry.args).Count -ne 0) { throw 'Native desktop entry was not registered to this isolated installation.' }
    $desktopKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($desktopTestRoot.Substring(5)+'\saltedfish-'+$desktopRecord.port+'\shell\open\command')
    try { if (-not $desktopKey -or $desktopKey.GetValue('') -cne ('"'+(Join-Path $installed 'data\desktop\SaltedFish.Settings.exe')+'" "%1"')) { throw 'Native protocol command differs from the dedicated GUI launcher.' } } finally { if($desktopKey){$desktopKey.Dispose()} }
    Assert-NativeSettings $installed
    $loadedExtension = Join-Path $testRoot 'original loaded extension'
    Copy-Item -LiteralPath (Join-Path $installed 'data\extension') -Destination $loadedExtension -Recurse
    & $launcher desktop register --extension-dir $loadedExtension
    if($LASTEXITCODE -ne 0){throw 'Explicit original extension directory registration failed.'}
    Assert-NativeSettings $installed $true $loadedExtension
    & $node (Join-Path $repo 'scripts\smoke-native-settings.mjs') (Join-Path $installed 'data')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged Native Messaging launcher failed.' }
    $v2 = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $installed 'data\opencode-config.json') | ConvertFrom-Json
    $v1 = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $installed 'data\opencode-v1-config.json') | ConvertFrom-Json
    if ($v2.mcp.servers.'saltedfish'.timeout.execution -ne 320000 -or $v1.mcp.'saltedfish'.timeout -ne 320000) { throw 'OpenCode version-specific configuration is invalid.' }
    Passed '离线安装到含中文与空格的目录'
    & $node (Join-Path $repo 'scripts\verify-package-client.mjs') $installed
    if ($LASTEXITCODE -ne 0) { throw 'Packaged MCP transport failed.' }
    Passed '不依赖系统 Node/npm 的原生启动器与 stdio'
    & $node (Join-Path $repo 'scripts\verify-package-client.mjs') $installed --legacy
    if ($LASTEXITCODE -ne 0) { throw 'Legacy launcher alias failed.' }
    Passed '新名称启动器及旧入口兼容同一 MCP 与授权'
    & $node (Join-Path $repo 'scripts\verify-package-trust.mjs') $installed
    if ($LASTEXITCODE -ne 0) { throw 'Packaged client trust setup failed.' }
    Passed '原生接入两客户端，一次信任、幂等、撤销和原文件恢复'
    $codex = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $installed 'data\clients\codex.json') | ConvertFrom-Json
    & $launcher clients revoke $codex.id | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Client revocation failed.' }
    [IO.File]::WriteAllText((Join-Path $installed 'data\keep-marker.txt'),'preserve data',$utf8)
    $serviceConfig = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $installed 'data\config.json') | ConvertFrom-Json
    $headers = @{Authorization=('Bearer '+$serviceConfig.token)}
    $rpc = 'http://127.0.0.1:'+$serviceConfig.port+'/rpc'
    $testProfile = [Guid]::NewGuid().ToString()
    $definition = @{name='package-workflow';steps=@(@{operation='page.action';args=@{action='fill';selector='#fixture';text='saved-value'}})}
    $saveBody = @{name='chrome_workflow_save';owner='package-check';args=@{profileId=$testProfile;definition=$definition}} | ConvertTo-Json -Depth 9
    $saved = Invoke-RestMethod -Uri $rpc -Method Post -Headers $headers -ContentType 'application/json' -Body $saveBody
    if (-not $saved.ok) { throw 'Packaged workflow save failed.' }
    $taskBody = @{name='chrome_task_submit';owner='package-check';args=@{profileId=$testProfile;tabId=1;name='never-replay';steps=$definition.steps}} | ConvertTo-Json -Depth 9
    $queued = Invoke-RestMethod -Uri $rpc -Method Post -Headers $headers -ContentType 'application/json' -Body $taskBody
    if (-not $queued.ok) { throw 'Packaged task persistence failed.' }
    Copy-Item -LiteralPath $extracted -Destination $upgrade -Recurse
    $nextVersion = Get-LaterVersion $package.version 'upgrade-test'
    $versionFile = Join-Path $upgrade 'payload\dist\version.js'
    [IO.File]::WriteAllText($versionFile,([IO.File]::ReadAllText($versionFile).Replace($package.version,$nextVersion)),$utf8)
    $releaseFile = Join-Path $upgrade 'payload\release.json'
    $release = Get-Content -Encoding UTF8 -Raw -LiteralPath $releaseFile | ConvertFrom-Json
    $release.version = $nextVersion
    [IO.File]::WriteAllText($releaseFile,($release | ConvertTo-Json),$utf8)
    $manifestFile = Join-Path $upgrade 'checksums.json'
    $manifest = Get-Content -Encoding UTF8 -Raw -LiteralPath $manifestFile | ConvertFrom-Json
    $manifest.version = $nextVersion
    foreach ($item in $manifest.files) { $item.sha256 = Get-Sha256 (Join-Path $upgrade $item.path) }
    [IO.File]::WriteAllText($manifestFile,($manifest | ConvertTo-Json -Depth 6),$utf8)
    Run-Installer $upgrade $installed
    if ((& $launcher version | ConvertFrom-Json).version -ne $nextVersion) { throw 'Upgrade did not switch versions.' }
    if ((Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $installed 'data\keep-marker.txt')) -ne 'preserve data') { throw 'Upgrade changed user data.' }
    $clients = (& $launcher clients list | ConvertFrom-Json).clients
    if (-not ($clients | Where-Object { $_.id -eq $codex.id -and $_.revoked })) { throw 'Upgrade revived revoked credentials.' }
    if (($clients | Where-Object { $_.label -eq 'codex' -and -not $_.revoked } | Measure-Object).Count -ne 0) { throw 'Upgrade silently created replacement credentials.' }
    $readBody = @{name='chrome_workflow_preview';owner='package-check';args=@{profileId=$testProfile;workflowId=$saved.data.id}} | ConvertTo-Json -Depth 5
    $preserved = Invoke-RestMethod -Uri $rpc -Method Post -Headers $headers -ContentType 'application/json' -Body $readBody
    if (-not $preserved.ok -or $preserved.data.revision -ne $saved.data.revision) { throw 'Upgrade changed the saved workflow.' }
    $readTask = @{name='chrome_task';owner='package-check';args=@{profileId=$testProfile;taskId=$queued.data.id}} | ConvertTo-Json -Depth 5
    $interrupted = Invoke-RestMethod -Uri $rpc -Method Post -Headers $headers -ContentType 'application/json' -Body $readTask
    if ($interrupted.data.status -ne 'interrupted') { throw 'Upgrade resumed a queued task instead of recording interruption.' }
    Assert-NativeSettings $installed $true $loadedExtension
    Passed '版本化升级保留数据和已撤销客户端状态'
    # 回归：新版多出来的扩展文件留到回滚之后，目录指纹对不上，本机设置入口登记不上。
    $newerExtensionFile = Join-Path $installed 'data\extension\icon-newer-release.png'
    [IO.File]::WriteAllBytes($newerExtensionFile,[byte[]](1,2,3))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'rollback.ps1') -InstallRoot $installed
    if ($LASTEXITCODE -ne 0 -or (& $launcher version | ConvertFrom-Json).version -ne $package.version) { throw 'Rollback failed.' }
    if (Test-Path -LiteralPath $newerExtensionFile) { throw 'Rollback left a newer release file in the extension folder.' }
    $clients = (& $launcher clients list | ConvertFrom-Json).clients
    if (-not ($clients | Where-Object { $_.id -eq $codex.id -and $_.revoked })) { throw 'Rollback revived credentials.' }
    Assert-NativeSettings $installed $true $loadedExtension
    Passed '兼容数据结构下回滚版本，保持撤销授权'
    # 回归：当前版本残缺（例如被中断的卸载）时，启动器无法执行 stop；仍要能回滚到完好的上一个版本。
    Run-Installer $upgrade $installed
    if ((& $launcher version | ConvertFrom-Json).version -ne $nextVersion) { throw 'Re-upgrade before the incomplete-version rollback check failed.' }
    & $launcher stop
    if ($LASTEXITCODE -ne 0) { throw 'Service did not stop before the incomplete-version rollback check.' }
    $idle = Wait-InstallIdle $installed 10
    if ($idle.Processes.Count -gt 0 -or $idle.Files.Count -gt 0) { throw 'The stopped service still holds the installation; cannot build the incomplete-version fixture.' }
    foreach ($name in @('dist','node_modules')) { Remove-Item -LiteralPath (Join-Path $installed ('versions\' + $nextVersion + '\' + $name)) -Recurse -Force }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'rollback.ps1') -InstallRoot $installed
    if ($LASTEXITCODE -ne 0 -or (& $launcher version | ConvertFrom-Json).version -ne $package.version) { throw 'Rollback away from an incomplete current version failed.' }
    Assert-NativeSettings $installed $true $loadedExtension
    Passed '当前版本残缺时仍可回滚到完好的上一个版本'
    $brokenVersion = Get-LaterVersion $package.version 'broken-test'
    [IO.File]::WriteAllText($versionFile,'this is intentionally invalid JavaScript',$utf8)
    $release.version = $brokenVersion
    [IO.File]::WriteAllText($releaseFile,($release | ConvertTo-Json),$utf8)
    $manifest.version = $brokenVersion
    foreach ($item in $manifest.files) { $item.sha256 = Get-Sha256 (Join-Path $upgrade $item.path) }
    [IO.File]::WriteAllText($manifestFile,($manifest | ConvertTo-Json -Depth 6),$utf8)
    $runtimeExitCode = Run-FailingInstaller $upgrade $installed
    if ($runtimeExitCode -eq 0 -or (& $launcher version | ConvertFrom-Json).version -ne $package.version) { throw 'Failed upgrade did not return to working version.' }
    $health = & $launcher doctor | ConvertFrom-Json
    if (-not $health.versionMatches) { throw 'Previous service was not restored after upgrade failure.' }
    Passed '已校验但无法启动的新版本自动退回原版本'
    [IO.File]::AppendAllText($versionFile,'corruption',$utf8)
    $badInstall = Join-Path $testRoot 'must-not-install'
    $exitCode = Run-FailingInstaller $upgrade $badInstall
    if ($exitCode -eq 0 -or (Test-Path -LiteralPath $badInstall)) { throw 'Corrupted package was not rejected before installation.' }
    Passed '文件校验失败时不创建安装目录'
    # 先装了 npm 版的机器：不带 -InstallRoot（Install.cmd 的路径）也能装成功，并且不碰 npm 的数据目录。
    $npmFirstRun = Join-Path $testRoot 'npm-first-run'
    New-MarkedDirectory (Join-Path $npmFirstRun 'SaltedFish\npm') 'saltedfish-npm'
    $previousAppData = $env:LOCALAPPDATA
    try {
        $env:LOCALAPPDATA = $npmFirstRun
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $extracted 'install.ps1') -Port 18422 -NoOnboarding -NoStart
        if ($LASTEXITCODE -ne 0) { throw 'Default install failed on a machine that already has an npm home.' }
    } finally { $env:LOCALAPPDATA = $previousAppData }
    $nativeBeside = Join-Path $npmFirstRun 'SaltedFish-native'
    if (-not (Test-Path -LiteralPath (Join-Path $nativeBeside 'SaltedFish.exe')) -or (Test-Path -LiteralPath (Join-Path $npmFirstRun 'SaltedFish\SaltedFish.exe')) -or -not (Test-Path -LiteralPath (Join-Path $npmFirstRun 'SaltedFish\npm\installation.json'))) { throw 'The default install did not land beside the npm home, or it touched the npm home.' }
    & (Join-Path $nativeBeside 'uninstall.ps1') -InstallRoot $nativeBeside -Confirm:$false
    Passed 'npm 版已占用默认目录时，不带 -InstallRoot 的安装改装到 SaltedFish-native 并成功'
    # 回归：客户端仍连着 MCP 时卸载。旧版会在被占用的 runtime\node.exe 处失败，而 dist、node_modules 已被删光，留下启动器、卸载和重装都无法恢复的空壳。
    $client = Start-McpClient $launcher
    try {
        if (-not (Wait-InstallProcess $installed 'cli\.js"?\s+"?mcp')) { throw 'The simulated MCP client did not start.' }
        $versionDirectory = Join-Path $installed ('versions\' + $package.version)
        $refusalFile = Join-Path $testRoot 'uninstall-refused.txt'
        $refusalExit = Run-Uninstaller $installed $refusalFile
        $refusalText = Get-Content -Encoding UTF8 -Raw -LiteralPath $refusalFile
        if ($refusalExit -eq 0) { throw 'Uninstall succeeded while an AI client was still connected.' }
        if ($refusalText -notmatch 'SaltedFish\.exe' -or $refusalText -notmatch 'node\.exe') { throw 'The refusal did not list the processes holding the installation.' }
        foreach ($required in @('dist\cli.js','node_modules','runtime\node.exe')) { if (-not (Test-Path -LiteralPath (Join-Path $versionDirectory $required))) { throw "Refused uninstall still removed $required." } }
        if (-not (Test-Path -LiteralPath $launcher) -or (Test-Path -LiteralPath (Join-Path $installed 'data\maintenance'))) { throw 'Refused uninstall left the installation in a maintenance state.' }
        if ((& $launcher version | ConvertFrom-Json).version -ne $package.version) { throw 'The installation stopped working after the refused uninstall.' }
        Passed '客户端仍连着 MCP 时卸载被拒绝并列出占用进程，安装目录保持完好'
        # 回归：被中断的卸载留下缺 dist、node_modules 的半成品，同版本重装要能补全；客户端仍占着 node.exe，所以不能靠整体替换版本目录。
        foreach ($name in @('dist','node_modules','docs')) { Remove-Item -LiteralPath (Join-Path $versionDirectory $name) -Recurse -Force }
        [IO.File]::WriteAllText((Join-Path $installed 'data\maintenance'),'uninstall',$utf8)
        & $launcher version | Out-Null
        if ($LASTEXITCODE -eq 0) { throw 'Test setup failed: the hollowed installation still runs.' }
        Run-Installer $extracted $installed
        if ((& $launcher version | ConvertFrom-Json).version -ne $package.version) { throw 'Same-version reinstall did not repair the hollow installation.' }
        $repairedManifest = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $extracted 'checksums.json') | ConvertFrom-Json
        if (@(Get-VersionFileProblems $versionDirectory $extracted $repairedManifest).Count -ne 0) { throw 'Some installed files still differ from the package after the repair.' }
        if ($client.HasExited) { throw 'The connected client was disturbed by the repair.' }
        Passed '残缺的安装目录由同版本安装器补全，客户端占着 node.exe 时同样成功'
    } finally { Stop-McpClient $client }
    if ($LegacyPackage) {
        $legacyExtracted = Join-Path $testRoot 'legacy-package'
        [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($LegacyPackage),$legacyExtracted)
        Run-Installer $legacyExtracted $legacyRoot
        if ((Get-DefaultInstallRoot $isolatedAppData) -ne $legacyRoot) { throw 'Legacy install was not discovered.' }
        $legacyVersion = (& $legacyLauncher version | ConvertFrom-Json).version
        $legacyLauncherHash = Get-Sha256 $legacyLauncher
        $legacyPairingHash = Get-Sha256 (Join-Path $legacyRoot 'data\extension\pairing.json')
        $legacyConfigHash = Get-Sha256 (Join-Path $legacyRoot 'data\config.json')
        $legacyClients = @(Get-ChildItem -LiteralPath (Join-Path $legacyRoot 'data\clients') -File | ForEach-Object { @{path=$_.FullName;hash=(Get-Sha256 $_.FullName)} })
        $previousAppData = $env:LOCALAPPDATA
        try {
            $env:LOCALAPPDATA = $isolatedAppData
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $extracted 'install.ps1') -NoOnboarding
            if ($LASTEXITCODE -ne 0) { throw 'Automatic legacy upgrade failed.' }
        } finally { $env:LOCALAPPDATA = $previousAppData }
        $saltedLauncher = Join-Path $legacyRoot 'SaltedFish.exe'
        if ((& $saltedLauncher version | ConvertFrom-Json).version -ne $package.version) { throw 'Renamed launcher did not run the new version.' }
        if ((Get-Sha256 $legacyLauncher) -ne $legacyLauncherHash) { throw 'Legacy launcher was overwritten.' }
        if ((& $legacyLauncher version | ConvertFrom-Json).version -ne $package.version) { throw 'Existing client path no longer works.' }
        if ((Get-Sha256 (Join-Path $legacyRoot 'data\extension\pairing.json')) -ne $legacyPairingHash -or (Get-Sha256 (Join-Path $legacyRoot 'data\config.json')) -ne $legacyConfigHash) { throw 'Renaming changed pairing or configuration.' }
        foreach ($credential in $legacyClients) { if ((Get-Sha256 $credential.path) -ne $credential.hash) { throw 'Renaming changed a client credential.' } }
        & $node (Join-Path $repo 'scripts\verify-package-client.mjs') $legacyRoot
        if ($LASTEXITCODE -ne 0) { throw 'Renamed MCP handshake failed after legacy upgrade.' }
        & $node (Join-Path $repo 'scripts\verify-package-client.mjs') $legacyRoot --legacy
        if ($LASTEXITCODE -ne 0) { throw 'Old client path handshake failed after legacy upgrade.' }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $legacyRoot 'rollback.ps1') -InstallRoot $legacyRoot
        $rollbackExit = $LASTEXITCODE
        $currentMetadata = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $legacyRoot ('versions\' + $package.version + '\release.json')) | ConvertFrom-Json
        $previousMetadata = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $legacyRoot ('versions\' + $legacyVersion + '\release.json')) | ConvertFrom-Json
        if ($currentMetadata.stateVersion -gt $previousMetadata.stateVersion) {
            if ($rollbackExit -eq 0 -or (& $saltedLauncher version | ConvertFrom-Json).version -ne $package.version) { throw 'Incompatible rollback was not rejected without switching version.' }
            foreach ($credential in $legacyClients) { if ((Get-Sha256 $credential.path) -ne $credential.hash) { throw 'Rejected rollback changed a client credential.' } }
        } elseif ($rollbackExit -ne 0 -or (& $saltedLauncher version | ConvertFrom-Json).version -ne $legacyVersion) { throw 'Compatible rollback across rename failed.' }
        & $saltedLauncher stop
        if ($LASTEXITCODE -ne 0) { throw 'Legacy test service did not stop.' }
        Passed '旧版默认目录升级、双入口、凭据保持及兼容回滚门槛'
    }
    & (Join-Path $installed 'uninstall.ps1') -InstallRoot $installed -Confirm:$false
    $desktopAfterUninstall=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($desktopTestRoot.Substring(5)+'\saltedfish-'+$desktopRecord.port)
    try { if($desktopAfterUninstall){throw 'Uninstall left its owned desktop registration behind.'} } finally {if($desktopAfterUninstall){$desktopAfterUninstall.Dispose()}}
    Assert-NativeSettings $installed $false
    if ((Test-Path -LiteralPath $launcher) -or (Test-Path -LiteralPath (Join-Path $installed 'FengChromeMCP.exe')) -or -not (Test-Path -LiteralPath (Join-Path $installed 'data\keep-marker.txt'))) { throw 'Uninstall did not preserve data while removing both app entry points.' }
    Passed '卸载程序保留用户数据'
    if (Test-Path -LiteralPath (Join-Path $installed 'versions')) { throw 'Uninstall left the versions directory behind.' }
    & (Join-Path $installed 'uninstall.ps1') -InstallRoot $installed -Confirm:$false
    if (-not (Test-Path -LiteralPath (Join-Path $installed 'data\keep-marker.txt'))) { throw 'A repeated uninstall removed user data.' }
    Passed '重复卸载是无副作用的空操作'
    # 验收记录绑定源码指纹；与同一份源码的 npm 候选包、同版本扩展 ZIP 互相印证（没有就如实记 null）。
    $npmBinding = $null
    $npmFile = Join-Path $repo '.local\last-npm-package.json'
    if (Test-Path -LiteralPath $npmFile) {
        $npmRecord = Get-Content -Encoding UTF8 -Raw -LiteralPath $npmFile | ConvertFrom-Json
        if ($npmRecord.version -eq $package.version) { $npmBinding = [ordered]@{ sha256=$npmRecord.sha256; sourceFingerprint=$npmRecord.sourceFingerprint; sameSource=($npmRecord.sourceFingerprint -eq $package.sourceFingerprint) } }
    }
    $extensionBinding = $null
    $extensionZip = Join-Path (Split-Path -Parent $package.zip) ('saltedfish-extension-' + $package.version + '.zip')
    if (Test-Path -LiteralPath $extensionZip) {
        $extensionExtracted = Join-Path $testRoot 'extension-zip'
        [IO.Compression.ZipFile]::ExtractToDirectory($extensionZip,$extensionExtracted)
        $packagedExtension = Join-Path $extracted 'payload\dist\extension'
        $listing = { param($directory) @(Get-ChildItem -LiteralPath $directory -Recurse -File | Sort-Object FullName | ForEach-Object { $_.FullName.Substring($directory.Length + 1).Replace('\','/') + ' ' + (Get-Sha256 $_.FullName) }) }
        if (((& $listing $packagedExtension) -join "`n") -ne ((& $listing $extensionExtracted) -join "`n")) { throw 'The extension ZIP differs from the extension inside the Windows package: rebuild one of them.' }
        $extensionBinding = [ordered]@{ file=[IO.Path]::GetFileName($extensionZip); sha256=(Get-Sha256 $extensionZip); matchesPackagedExtension=$true }
    }
    New-Item -ItemType Directory -Path (Join-Path $repo '.local\verification') -Force | Out-Null
    $report = @{version=$package.version;sha256=$packageHash;sourceFingerprint=$package.sourceFingerprint;packagingFingerprint=$package.packagingFingerprint;docs=@($shippedDocs);npm=$npmBinding;extensionZip=$extensionBinding;scope='原生安装验收（含包内帮助检查与卸载保护），绑定源码指纹；不含与 npm 包的逐字节比对，不代表公开发行认证';checks=@($checks);passed=$true;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $repo '.local\verification\package-report.json'),$report,$utf8)
    [IO.File]::WriteAllText(($package.zip+'.verification.json'),$report,$utf8)
} finally {
    if (Test-Path -LiteralPath $launcher) { & $launcher stop | Out-Null }
    if (Test-Path -LiteralPath $legacyLauncher) { & $legacyLauncher stop | Out-Null }
    $cleanup = Assert-Child $testRoot $testBase
    if (Test-Path -LiteralPath $cleanup) { Remove-Item -LiteralPath $cleanup -Recurse -Force }
    try {
        $relative=$desktopTestRoot.Substring(5)
        if ($relative -notmatch '^Software\\SaltedFish\\Tests\\Desktop_[a-f0-9]{32}$') { throw 'Unsafe desktop registry cleanup path' }
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($relative,$false)
        if ((Get-ProductionDesktopSnapshot) -cne $desktopBefore) { throw 'A native package test changed production desktop registrations' }
        $nativeRelative=$nativeTestRoot.Substring(5)
        if ($nativeRelative -notmatch '^Software\\SaltedFish\\Tests\\Native_[a-f0-9]{32}$') { throw 'Unsafe native messaging registry cleanup path' }
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($nativeRelative,$false)
        if ((Get-ProductionNativeSnapshot) -cne $nativeBefore) { throw 'A native package test changed production native messaging registrations' }
    } finally {
        if ($null -eq $previousDesktopTestRoot) { Remove-Item Env:SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT -ErrorAction SilentlyContinue } else { $env:SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT=$previousDesktopTestRoot }
        if ($null -eq $previousNativeTestRoot) { Remove-Item Env:SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT -ErrorAction SilentlyContinue } else { $env:SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT=$previousNativeTestRoot }
    }
}
