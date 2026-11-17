#requires -Version 5.1
[CmdletBinding()]
param([string]$ProjectPath, [int]$WatchParent = 0, [string]$WatchService = '', [string]$WatchMinio = '')
$ErrorActionPreference = 'Stop'

if ($WatchParent -gt 0) {
    try {
        $parentProcess = Get-Process -Id $WatchParent -ErrorAction Stop
        $parentProcess.WaitForExit()
    } catch { }
    if ($WatchMinio) {
        # Include a process still starting up that has not yet opened its port.
        $owners = @(Get-CimInstance Win32_Process -Filter "Name='minio.exe'" -ErrorAction SilentlyContinue)
        foreach ($owner in $owners) {
            if ($owner.ExecutablePath -eq $WatchMinio) { Stop-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue }
        }
    }
    if ($WatchService) {
        try { Stop-Service -Name $WatchService -ErrorAction Stop } catch {
            Write-EventLog -LogName Application -Source 'Application Error' -EventId 1000 -EntryType Error -Message 'Patent ETL could not stop its PostgreSQL service.' -ErrorAction SilentlyContinue
        }
    }
    exit 0
}

function Get-ConfigValue([string]$Text, [string]$Key) {
    $match = [regex]::Match($Text, '(?m)^\s*' + [regex]::Escape($Key) + '=([^\r\n]*)')
    if ($match.Success) { return $match.Groups[1].Value.Trim().Trim('"').Trim("'") }
    return ''
}
function Test-LocalPort([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connection = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(1000)) { return $false }
        $client.EndConnect($connection)
        return $true
    } catch { return $false } finally { $client.Close() }
}

try {
    if (-not $ProjectPath) {
        $installed = Join-Path $PSScriptRoot 'patent-etl-nodejs'
        $parent = Split-Path -Parent $PSScriptRoot
        if (Test-Path -LiteralPath (Join-Path $installed 'package.json')) { $ProjectPath = $installed }
        elseif (Test-Path -LiteralPath (Join-Path $parent 'package.json')) { $ProjectPath = $parent }
        else { throw '找不到项目。请将启动文件与一键安装文件放在同一文件夹，先运行一键安装。' }
    }
    $target = [IO.Path]::GetFullPath($ProjectPath)
    if (-not (Test-Path -LiteralPath (Join-Path $target 'package.json'))) { throw '找不到项目目录，请先运行一键安装。' }
    $envFile = Join-Path $target '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { throw '缺少 .env 配置，请先完成安装和配置。' }
    if (-not (Test-Path -LiteralPath (Join-Path $target 'node_modules\next\package.json'))) { throw '项目依赖未安装，请先运行一键安装。' }
    $env:Path = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw '找不到 Node.js 或 Corepack，请先运行一键安装。' }
    if (Test-LocalPort 3000) { throw '本机 3000 端口已被占用。请检查是否已有工作台或其他程序运行。' }
    Set-Location -LiteralPath $target
    $config = [IO.File]::ReadAllText($envFile)

    $pgHost = Get-ConfigValue $config 'CNIPA_PG_HOST'
    $pgPortText = Get-ConfigValue $config 'CNIPA_PG_PORT'
    $pgPort = 5432
    if ($pgPortText -match '^\d+$') { $pgPort = [int]$pgPortText }
    $pgService = ''
    $localPostgres = ($pgHost -eq '127.0.0.1' -or $pgHost -eq 'localhost') -and -not (Get-ConfigValue $config 'DATABASE_URL')
    if ($localPostgres) {
        $services = @(Get-CimInstance Win32_Service -Filter "Name LIKE 'postgresql%'" -ErrorAction Stop)
        if (Test-LocalPort $pgPort) {
            $owners = @(Get-NetTCPConnection -LocalPort $pgPort -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
            $services = @($services | Where-Object { $_.ProcessId -and $owners -contains $_.ProcessId })
        }
        if ($services.Count -ne 1) { throw "无法唯一确定端口 $pgPort 对应的 PostgreSQL 服务，请检查服务和端口。" }
        $pgService = $services[0].Name
    }

    $storage = Get-ConfigValue $config 'OBJECT_STORAGE_TYPE'
    $endpoint = Get-ConfigValue $config 'MINIO_ENDPOINT'
    $minioExe = ''
    if ($storage -eq 'minio' -and $endpoint -match '^http://(localhost|127\.0\.0\.1):9000/?$') {
        $minioExe = Join-Path $target 'data\local-services\minio.exe'
        $minioData = Join-Path $target 'data\local-services\minio-data'
        if (-not (Test-Path -LiteralPath $minioExe) -or -not (Test-Path -LiteralPath $minioData)) { throw '找不到本地 MinIO 程序或数据目录，请先完成一键安装。' }
        $listener = Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
            if ($owner.ExecutablePath -ne $minioExe) { throw '9000 端口已被其他程序占用，请检查后重试。' }
        }
    }

    # A separate process survives a console-window close, where finally blocks may not run.
    $scriptPath = $PSCommandPath.Replace("'", "''")
    $safeService = $pgService.Replace("'", "''")
    $safeMinio = $minioExe.Replace("'", "''")
    $watchCommand = "& '$scriptPath' -WatchParent $PID -WatchService '$safeService' -WatchMinio '$safeMinio'"
    $watchEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCommand))
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $watchEncoded) -WindowStyle Hidden | Out-Null

    if ($pgService -and -not (Test-LocalPort $pgPort)) {
        Write-Host '正在启动 PostgreSQL 服务……'
        try { Start-Service -Name $pgService } catch { throw '无法启动 PostgreSQL 服务，请检查 Windows 服务状态或使用管理员权限启动。' }
    }
    if ($minioExe) {
        if (-not $listener) {
            $env:MINIO_ROOT_USER = Get-ConfigValue $config 'MINIO_ACCESS_KEY'
            $env:MINIO_ROOT_PASSWORD = Get-ConfigValue $config 'MINIO_SECRET_KEY'
            if (-not $env:MINIO_ROOT_USER -or -not $env:MINIO_ROOT_PASSWORD) { throw 'MinIO 账号或密码未配置，请检查 .env。' }
            Write-Host '正在启动本地 MinIO……'
            try { Start-Process -FilePath $minioExe -ArgumentList @('server', ('"' + $minioData + '"'), '--address', '127.0.0.1:9000', '--console-address', '127.0.0.1:9001') -WindowStyle Hidden } finally {
                Remove-Item Env:MINIO_ROOT_USER -ErrorAction SilentlyContinue
                Remove-Item Env:MINIO_ROOT_PASSWORD -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Host '正在检查数据库和对象存储连接……'
    $js = 'require("module").createRequire(require.resolve("next/package.json"))("@next/env").loadEnvConfig(process.cwd()); const {Pool}=require("pg"); const c=process.env; (async()=>{const pool=new Pool(c.DATABASE_URL?{connectionString:c.DATABASE_URL,connectionTimeoutMillis:5000}:{host:c.CNIPA_PG_HOST,port:Number(c.CNIPA_PG_PORT||5432),database:c.CNIPA_PG_DB,user:c.CNIPA_PG_USER,password:c.CNIPA_PG_PASSWORD,connectionTimeoutMillis:5000});try{await pool.query("SELECT 1")}finally{await pool.end()} if(c.OBJECT_STORAGE_TYPE==="minio" && c.PROCESS_UPLOAD_IMAGES!=="0"){const u=new URL(c.MINIO_ENDPOINT);const M=require("minio");const m=new M.Client({endPoint:u.hostname,port:Number(u.port||(u.protocol==="https:"?443:80)),useSSL:u.protocol==="https:",accessKey:c.MINIO_ACCESS_KEY,secretKey:c.MINIO_SECRET_KEY});let last;for(let i=0;i<20;i++){try{if(!await m.bucketExists(c.MINIO_BUCKET_NAME))throw Error("存储桶不存在");return}catch(e){last=e;await new Promise(r=>setTimeout(r,1000))}}throw last}})().catch(e=>{console.error("服务检查失败，请检查数据库或对象存储配置："+e.message);process.exit(1)})'
    $encodedJs = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
    & node -e "eval(Buffer.from('$encodedJs','base64').toString())"
    if ($LASTEXITCODE -ne 0) { throw '服务检查未通过，请修复上方问题后重新启动。' }

    Write-Host '正在启动工作台。请保持此窗口打开；关闭窗口会停止工作台。'
    Write-Host '服务就绪后将在浏览器打开 http://localhost:3000。'
    $browserJob = Start-Job -ScriptBlock {
        for ($i = 0; $i -lt 120; $i++) {
            Start-Sleep -Seconds 1
            try {
                $response = Invoke-WebRequest -Uri 'http://localhost:3000' -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { Start-Process 'http://localhost:3000'; return }
            } catch { }
        }
    }
    try {
        & corepack pnpm dev
        if ($LASTEXITCODE -ne 0) { throw "工作台启动失败，退出代码：$LASTEXITCODE。" }
    } finally { Stop-Job $browserJob -ErrorAction SilentlyContinue; Remove-Job $browserJob -Force -ErrorAction SilentlyContinue }
} catch {
    Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
