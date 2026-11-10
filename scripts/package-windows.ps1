[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
# 同 test-package.ps1：PowerShell 5 用系统代码页写出中文，打包失败时抛的中文原因在日志里会变成乱码。只改本进程。
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { Write-Verbose "未能切换控制台输出编码：$($_.Exception.Message)" }
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot '..\release' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'packaging\common.ps1')
Set-Location -LiteralPath $repo
$package = Get-Content -Encoding UTF8 -Raw package.json | ConvertFrom-Json
$version = $package.version
$zip = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) "saltedfish-$version-windows-x64.zip"
if (Test-Path -LiteralPath $zip) { throw '已有同版本 Windows 包，禁止覆盖；请使用新的版本号。' }
$node = (Get-Command node.exe).Source
# 源码指纹（scripts/release-evidence.mjs，npm 候选包也用它）在构建之前固定：不能用打包结束时的新指纹，为此前构建的旧 dist 背书。
function Get-SourceFingerprint([string]$NodePath) {
    $probe = "import { sourceFingerprint } from './scripts/release-evidence.mjs'; console.log(await sourceFingerprint(process.cwd()))"
    $value = (& $NodePath --input-type=module -e $probe | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $value -notmatch '^[a-f0-9]{64}$') { throw '无法计算源码指纹。' }
    return $value
}
# Windows 包的 README 用这份专用模板，不直接拷仓库 README（它链向 src、发行记录等包里没有的文件）。
# 变量由 package.json 和 extension/manifest.json 渲染，写好后与 npm 包同一个 checkPackagedDocs 检查链接、变量和安装命令版本。
$windowsReadme = @'
# SaltedFish（Windows 独立安装包）

让 AI 使用你已登录的 Chrome。当前版本 **{{version}}**，Chrome 扩展内部版本 **{{extensionVersion}}**。本包自带经过签名验证的 Node 运行时，不需要预装 Node.js、npm，也不需要管理员权限。

这是离线分发的 Windows 安装包；产品自身没有代码签名，Windows 可能要求确认来源。请用随包提供的 SHA256 与验收记录核对来源。

## 安装

解压后运行 **Install.cmd**。默认装到 `%LOCALAPPDATA%\SaltedFish`；已有旧版安装（`SaltedFish` 或 `FengChromeMCP` 目录）会原位升级。如果 `SaltedFish` 已被 npm 版占用（里面只有 npm 的数据目录），安装器改装到 `%LOCALAPPDATA%\SaltedFish-native`，并在输出里说明。要指定位置，在 PowerShell 里运行 `install.ps1 -InstallRoot <目录>`，以后升级继续用同一个目录。

安装后：

1. 打开安装后出现的服务管理页；以后可在安装目录运行 `.\SaltedFish.exe dashboard`。在“浏览器连接”中新增浏览器并复制连接码。
2. 在要接入的 Chrome 用户配置里打开 `chrome://extensions`，开启开发者模式，“加载已解压的扩展程序”，选择安装器输出的 **data\extension** 目录。在扩展设置粘贴连接码、连接服务，并给浏览器命名。扩展可直接连接内网 IP 的 HTTP 服务或 HTTPS 服务。
3. 在服务管理页的“Agent”中新增授权，复制对应客户端的 MCP 配置。Claude Desktop 通过 stdio 桥接连接远端服务，要完全退出并重启；WorkBuddy 要刷新 MCP 并批准配置；其他客户端新开会话或重载 MCP。具体路径见下方“Agent 兼容范围”。本机客户端自动配置入口保留在高级设置。

服务可部署在这台电脑或服务器上。普通浏览器操作和上传服务中的文件均由扩展直连服务；导出 Chrome 已下载的文件时，才需要浏览器所在 Windows 的可选文件助手。安装助手使用 `.\SaltedFish.exe helper install`，无需启动本机浏览器服务。

## 升级、回滚与卸载

- **升级：** 解压新版本，再次运行 Install.cmd。程序装在独立的版本目录，数据目录保持不变；更新了扩展代码时，在 Chrome 扩展管理页刷新一次。
- **回滚：** 在安装目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1`。只切换兼容的程序版本，保留当前操作记录和已撤销的授权；数据结构不兼容时拒绝回滚。
- **卸载：** 先关闭仍连着 SaltedFish 的 AI 客户端（Codex、OpenCode、Claude 等），再运行安装目录的 `uninstall.ps1` 并确认。它停止服务、移除程序，保留 data；Chrome 扩展和各客户端里的 saltedfish 配置由你自己移除。客户端还开着时，卸载会列出占用安装目录的进程并拒绝，不会删除任何文件。
- **安装目录不完整：** 被中断的卸载或升级、清理软件误删文件，会让启动器提示“安装文件不完整”。重新运行同一版本的 Install.cmd，会按清单补全缺失的文件，数据不受影响；没有安装包而又有上一个版本时，可用 `rollback.ps1` 退回去。

## 使用指南

- [浏览器、任务、流程与故障恢复](docs/product-features.md)
- [一次信任与撤销](docs/once-trust.md)
- [Agent 兼容范围](docs/supported-clients.md)
- [输入语义与可观察边界](docs/interaction.md)
- [限制与数据说明](docs/beta-limitations.md)
- [名称与既有安装兼容](docs/branding.md)
- [npm 分发说明（另一种安装方式）](docs/npm.md)

每个 Chrome 配置以持久 ID 隔离；名称仅用于辨认，同名不等于同一账号。离线不自动换号。未知结果需要先核查页面，不自动重试已派发的业务动作。
'@
# Windows 包只带随包帮助白名单里的文档（与 npm 包同一份清单 scripts/release-docs.mjs）；检查不过就不生成安装包。
function New-PayloadDocs([string]$PayloadRoot, [string]$NodePath, [string]$ProductVersion, [string]$ExtensionVersion) {
    $listProbe = "import { packagedDocs } from './scripts/release-docs.mjs'; console.log(packagedDocs.join(String.fromCharCode(10)))"
    $docs = @(& $NodePath --input-type=module -e $listProbe | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0 -or $docs.Count -lt 1) { throw '无法读取随包帮助清单。' }
    foreach ($doc in $docs) {
        $target = Join-Path $PayloadRoot $doc.Replace('/','\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $doc.Replace('/','\')) -Destination $target
    }
    $readme = $windowsReadme.Replace('{{version}}',$ProductVersion).Replace('{{extensionVersion}}',$ExtensionVersion).Replace("`r`n","`n")
    [IO.File]::WriteAllText((Join-Path $PayloadRoot 'README.md'),$readme,[Text.UTF8Encoding]::new($false))
    $checkProbe = "import { checkPackagedDocs } from './scripts/release-docs.mjs'; await checkPackagedDocs(process.argv[1])"
    & $NodePath --input-type=module -e $checkProbe $PayloadRoot
    if ($LASTEXITCODE -ne 0) { throw 'Windows 包内帮助检查失败（链接不可达、变量未渲染或安装命令版本过时），未生成分发包。' }
    return $docs
}
$fingerprint = Get-SourceFingerprint $node
$packagingFingerprint = Get-PackagingFingerprint $repo
& npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw '构建失败。' }
& $node (Join-Path $repo 'scripts\check-release.mjs'); if ($LASTEXITCODE -ne 0) { throw '源码、构建或文档版本不一致，未生成分发包。' }
$signature = Get-AuthenticodeSignature -LiteralPath $node
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenJS Foundation') { throw 'Node 运行时没有有效的 OpenJS 签名，拒绝打包。' }
$nodeVersion = (& $node --version).Trim()
$architecture = (& $node -p 'process.arch').Trim()
if ($architecture -ne 'x64' -or $nodeVersion -notmatch '^v(2[4-9]|[3-9][0-9])\.') { throw '此安装包要求 Node 24+ Windows x64 运行时。' }
$stage = Join-Path $repo ('.packaging\' + $version + '-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $stage 'payload'
New-Item -ItemType Directory -Path $payload -Force | Out-Null
foreach ($directory in @('dist','ui')) { Copy-Item -LiteralPath (Join-Path $repo $directory) -Destination (Join-Path $payload $directory) -Recurse }
foreach ($file in @('package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $payload $file) }
$extensionVersion = (Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $repo 'extension\manifest.json') | ConvertFrom-Json).version
$packagedDocs = New-PayloadDocs $payload $node $version $extensionVersion
Push-Location -LiteralPath $payload
try { & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw '生产依赖安装失败。' } } finally { Pop-Location }
New-Item -ItemType Directory -Path (Join-Path $payload 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $payload 'runtime\node.exe')
Invoke-WebRequest "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $payload 'runtime\LICENSE.txt') -UseBasicParsing -TimeoutSec 30
$utf8 = [Text.UTF8Encoding]::new($false)
$stateProbe = "import { STATE_VERSION } from './dist/version.js'; console.log(STATE_VERSION)"
$stateVersion = [int](& $node --input-type=module -e $stateProbe)
if ($LASTEXITCODE -ne 0 -or $stateVersion -lt 1) { throw '无法读取发行数据兼容版本。' }
$release = @{ product='feng-chrome-mcp';displayName='SaltedFish';version=$version;stateVersion=$stateVersion;protocolVersion=1;platform='win32-x64';node=$nodeVersion;nodeSigner=$signature.SignerCertificate.Subject }
[IO.File]::WriteAllText((Join-Path $payload 'release.json'),($release | ConvertTo-Json),$utf8)
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /platform:x64 "/out:$(Join-Path $stage 'SaltedFish.exe')" (Join-Path $repo 'packaging\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw '原生启动器编译失败。' }
foreach ($file in @('install.ps1','rollback.ps1','common.ps1','uninstall.ps1','Install.cmd')) { Copy-Item -LiteralPath (Join-Path $repo "packaging\$file") -Destination (Join-Path $stage $file) }
$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{ path=$_.FullName.Substring($stage.Length+1).Replace('\','/');sha256=(Get-Sha256 $_.FullName) }
})
[IO.File]::WriteAllText((Join-Path $stage 'checksums.json'),(@{product='feng-chrome-mcp';displayName='SaltedFish';version=$version;files=$files} | ConvertTo-Json -Depth 6),$utf8)
# 打包期间源码、测试或 packaging 下的安装脚本变了，安装包就和登记的指纹对不上：不生成、不登记，重新打包。
if ((Get-SourceFingerprint $node) -ne $fingerprint -or (Get-PackagingFingerprint $repo) -ne $packagingFingerprint) { throw '打包期间源码、测试或安装脚本发生变化，未生成安装包；请重新打包。' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$hash = Get-Sha256 $zip
[IO.File]::WriteAllText(($zip+'.sha256'),($hash+'  '+[IO.Path]::GetFileName($zip)+"`n"),$utf8)
[IO.File]::WriteAllText((Join-Path $repo '.local\last-package.json'),(@{zip=$zip;stage=$stage;sha256=$hash;version=$version;sourceFingerprint=$fingerprint;packagingFingerprint=$packagingFingerprint;docs=@($packagedDocs)} | ConvertTo-Json),$utf8)
Write-Output "安装包：$zip"
Write-Output "SHA256：$hash"
