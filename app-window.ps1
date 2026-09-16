param(
    [int]$Port = 5367,
    [string]$DataDir = 'data-work',
    [string]$Title = 'Novel Studio',
    [switch]$Seed
)

# 启动工作台：先拉起本地服务，再用 Edge/Chrome 的 --app 模式打开一个无地址栏的独立窗口。
# 窗口关闭后自动停掉服务，不留后台进程。

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-PortOpen {
    param([int]$p)
    try {
        $t = New-Object System.Net.Sockets.TcpClient
        $t.Connect('127.0.0.1', $p)
        $t.Close()
        return $true
    } catch { return $false }
}

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe"
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Find-Browser {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
    )
    foreach ($k in $keys) {
        if (Test-Path $k) {
            $v = (Get-Item $k).GetValue('')
            if ($v -and (Test-Path $v)) { return $v }
        }
    }
    $files = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )
    foreach ($f in $files) { if ($f -and (Test-Path $f)) { return $f } }
    return $null
}

# ---------- 1. 找 Node ----------
$node = Find-Node
if (-not $node) {
    Write-Host ''
    Write-Host '  [错误] 没有在这台电脑上找到 Node.js。'
    Write-Host '  请到 https://nodejs.org 下载 LTS 版本，按默认选项安装后重试。'
    Write-Host ''
    Read-Host '  按回车关闭'
    exit 1
}

# ---------- 2. 起服务（端口已被占用就复用，不重复启动） ----------
$already = Test-PortOpen $Port
$nodeProc = $null

if ($already) {
    Write-Host "  端口 $Port 上已经有一个实例在运行，直接打开窗口。"
} else {
    $nodeArgs = @("$here\server\index.js", "$Port", "--data=$DataDir")
    if ($Seed) { $nodeArgs += '--seed' }
    try {
        $nodeProc = Start-Process -FilePath $node -ArgumentList $nodeArgs `
            -WorkingDirectory $here -WindowStyle Minimized -PassThru
    } catch {
        Write-Host "  [错误] 服务启动失败：$($_.Exception.Message)"
        Read-Host '  按回车关闭'
        exit 1
    }

    Write-Host "  正在启动服务（端口 $Port，数据目录 $DataDir）..."
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-PortOpen $Port) { $ready = $true; break }
    }
    if (-not $ready) {
        Write-Host '  [错误] 服务在预期时间内没有响应，请检查控制台窗口里的报错。'
        if ($nodeProc -and -not $nodeProc.HasExited) { Stop-Process -Id $nodeProc.Id -Force }
        Read-Host '  按回车关闭'
        exit 1
    }
}

# ---------- 3. 开窗口 ----------
$url = "http://localhost:$Port"
$profileDir = Join-Path $env:LOCALAPPDATA "NovelStudio\profile-$Port"
if (-not (Test-Path (Split-Path $profileDir))) {
    New-Item -ItemType Directory -Path (Split-Path $profileDir) -Force | Out-Null
}

try {
    $browser = Find-Browser
    if ($browser) {
        $appArgs = @(
            "--app=$url",
            '--window-size=1440,920',
            "--user-data-dir=`"$profileDir`"",
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate'
        )
        Write-Host "  已就绪：$url"
        Write-Host '  关掉这个窗口就会自动停止服务。'
        Start-Process -FilePath $browser -ArgumentList $appArgs -Wait
    } else {
        Write-Host '  没有检测到 Edge / Chrome，改用系统默认浏览器打开。'
        Write-Host "  地址：$url"
        Start-Process $url
        Read-Host '  看完后按回车停止服务'
    }
} finally {
    if ($nodeProc -and -not $nodeProc.HasExited) {
        Write-Host '  正在停止服务...'
        Stop-Process -Id $nodeProc.Id -Force
    }
}
