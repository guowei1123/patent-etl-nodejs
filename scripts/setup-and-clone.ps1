#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $PSScriptRoot 'patent-etl-nodejs'),
    [string]$Repository = 'https://github.com/guowei1123/patent-etl-nodejs.git'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Update-ProcessPath {
    $env:Path = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
}
function Install-WingetPackage([string]$Id, [switch]$Interactive) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw '未找到 winget，请安装或更新 Windows“应用安装程序”。' }
    $options = @('install', '--id', $Id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
    if ($Interactive) { $options += '--interactive' }
    & winget @options
    if ($LASTEXITCODE -ne 0) { throw "安装 $Id 失败，退出代码：$LASTEXITCODE。" }
    Update-ProcessPath
}
function Ensure-Command([string]$Command, [string]$Id) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        Write-Host "正在安装 $Command，请按系统提示完成安装……"
        Install-WingetPackage $Id
    }
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "找不到 $Command，请重新打开窗口运行。" }
}
function New-LocalSecret {
    $bytes = New-Object byte[] 24
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}
function Read-LoginPassword {
    while ($true) {
        $first = Read-Host '请设置工作台登录密码（至少 8 位，仅限英文字母、数字、下划线、点、连字符）' -AsSecureString
        $second = Read-Host '请再次输入登录密码' -AsSecureString
        $firstPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first)
        $secondPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($second)
        try {
            $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPtr)
            $confirmation = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPtr)
            if ($password -cne $confirmation) { Write-Host '两次密码不一致，请重新输入。'; continue }
            if ($password -notmatch '^[A-Za-z0-9_.-]{8,}$') { Write-Host '密码格式不符合要求，请重新输入。'; continue }
            return $password
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPtr)
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPtr)
            $first.Dispose()
            $second.Dispose()
        }
    }
}
function Find-Psql {
    $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $found = Get-ChildItem -Path (Join-Path $env:ProgramFiles 'PostgreSQL\*\bin\psql.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}
function Set-EnvValue([string]$Content, [string]$Key, [string]$Value) {
    $pattern = '(?m)^' + [regex]::Escape($Key) + '=.*\r?$'
    if ($Content -notmatch $pattern) { throw "配置模板缺少 $Key。" }
    return [regex]::Replace($Content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $Key + '=' + $Value })
}
function Get-EnvValue([string]$Content, [string]$Key) {
    $match = [regex]::Match($Content, '(?m)^' + [regex]::Escape($Key) + '=([^\r\n]*)')
    if (-not $match.Success) { throw "配置缺少 $Key。" }
    return $match.Groups[1].Value
}
function ConvertTo-EnvLiteral([string]$Value) {
    if ($Value -match '[\r\n"\\]') { throw '输入包含换行、双引号或反斜杠，请改用其他值或稍后手动配置。' }
    return '"' + $Value.Replace('$', '\$') + '"'
}
function Read-SecretValue([string]$Prompt) {
    while ($true) {
        $secret = Read-Host $Prompt -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secret.Dispose() }
        if ([string]::IsNullOrWhiteSpace($value)) { Write-Host '此项不能为空，请重新输入。'; continue }
        if ($value -match '[\r\n"\\]') { Write-Host '不支持换行、双引号或反斜杠，请重新输入。'; continue }
        return $value
    }
}
function Read-RequiredValue([string]$Prompt) {
    while ($true) {
        $value = (Read-Host $Prompt).Trim()
        if ([string]::IsNullOrWhiteSpace($value)) { Write-Host '此项不能为空，请重新输入。'; continue }
        if ($value -match '[\r\n"\\]') { Write-Host '不支持换行、双引号或反斜杠，请重新输入。'; continue }
        return $value
    }
}
function Configure-UserOptions([string]$Content, [bool]$RequireFtp = $false) {
    Write-Host 'FTP 账号获取：访问 https://ipdps.cnipa.gov.cn/#/Login 注册并登录知识产权数据资源公共服务系统。'
    Write-Host '在下载中心查看 FTP 地址及使用说明；FTP 用户名和密码以该系统提供的信息为准。'
    Write-Host '如使用单位提供的数据源，请联系管理员获取对应 FTP 账号。'
    if ($RequireFtp -or (Read-Host '是否修改 FTP 配置？输入 Y 修改，其他内容保留') -match '^[Yy]$') {
        $hostValue = Read-Host 'FTP 地址（留空沿用配置模板）'
        if ($hostValue.Trim()) { $Content = Set-EnvValue $Content 'CNIPA_FTP_HOST' (ConvertTo-EnvLiteral $hostValue.Trim()) }
        while ($true) {
            $portValue = (Read-Host 'FTP 端口（留空使用 21）').Trim()
            if (-not $portValue) { $portValue = '21' }
            $number = 0
            if ([int]::TryParse($portValue, [ref]$number) -and $number -ge 1 -and $number -le 65535) { break }
            Write-Host '端口须为 1 到 65535 的整数。'
        }
        $Content = Set-EnvValue $Content 'CNIPA_FTP_PORT' $portValue
        $Content = Set-EnvValue $Content 'CNIPA_FTP_USER' (ConvertTo-EnvLiteral (Read-RequiredValue 'FTP 用户名'))
        $Content = Set-EnvValue $Content 'CNIPA_FTP_PASSWORD' (ConvertTo-EnvLiteral (Read-SecretValue 'FTP 密码（输入时不显示）'))
        Write-Host '数据根目录按发明授权、实用新型、发明申请顺序填写，以英文逗号分隔；留空保留模板中的目录。'
        $paths = Read-Host 'FTP 数据根目录'
        if ($paths.Trim()) { $Content = Set-EnvValue $Content 'CNIPA_FTP_DATA_PATHS' (ConvertTo-EnvLiteral $paths.Trim()) }
    }
    Write-Host '默认白名单会过滤数据：满足 IPC 或实体白名单之一的专利才会导入。'
    if ((Read-Host '是否自定义白名单？输入 Y 配置，其他内容保留当前设置') -match '^[Yy]$') {
        Write-Host '请输入英文逗号分隔的内容；可将其中一项留空，但两项不能同时为空。'
        do {
            $ipc = (Read-Host 'IPC 分类号白名单').Trim()
            $entities = (Read-Host '申请人、发明人或专利权人关键词白名单').Trim()
            if (-not $ipc -and -not $entities) { Write-Host '两项都为空将无法匹配专利，请至少填写一项。' }
        } while (-not $ipc -and -not $entities)
        $Content = Set-EnvValue $Content 'PATENT_FILTER_IPC_WHITELIST' (ConvertTo-EnvLiteral $ipc)
        $Content = Set-EnvValue $Content 'PATENT_FILTER_ENTITY_WHITELIST' (ConvertTo-EnvLiteral $entities)
    }
    Write-Host 'AI 检索式生成功能可选；不配置不会阻止专利下载和导入。'
    if ((Read-Host '是否现在配置 AI 服务？输入 Y 配置，其他内容跳过') -match '^[Yy]$') {
        $apiBase = Read-RequiredValue '兼容 OpenAI 的 API 地址（例如 https://api.example.com/v1）'
        $model = Read-RequiredValue '聊天模型名称'
        $apiKey = Read-SecretValue 'API 密钥（输入时不显示）'
        $Content = Set-EnvValue $Content 'OPENAI_BASE_URL' (ConvertTo-EnvLiteral $apiBase)
        $Content = Set-EnvValue $Content 'OPENAI_CHAT_MODEL' (ConvertTo-EnvLiteral $model)
        $Content = Set-EnvValue $Content 'OPENAI_API_KEY' (ConvertTo-EnvLiteral $apiKey)
    }
    return $Content
}

try {
    $target = [IO.Path]::GetFullPath($Destination)
    Ensure-Command 'node' 'OpenJS.NodeJS.LTS'
    Ensure-Command 'git' 'Git.Git'
    $nodeVersion = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'20.9.0') { throw '请升级 Node.js 至 20.9 或更高版本，建议使用 22。' }
    if (Test-Path -LiteralPath $target) {
        $remote = & git -C $target remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0 -or $remote -ne $Repository) { throw "目标目录已存在且不是预期仓库：$target。请检查目录后重试。" }
        if ((Read-Host '已有项目目录。输入 Y 使用现有文件继续安装') -notmatch '^[Yy]$') { exit 0 }
    } else {
        & git clone -- $Repository $target
        if ($LASTEXITCODE -ne 0) { throw "克隆失败，请检查网络和仓库权限。不完整目录可能保留在 $target。" }
    }
    Set-Location -LiteralPath $target
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
        & npm install --global corepack
        if ($LASTEXITCODE -ne 0) { throw 'Corepack 安装失败，请检查网络和权限。' }
        Update-ProcessPath
    }
    & corepack prepare pnpm@10.32.1 --activate
    if ($LASTEXITCODE -ne 0) { throw '准备 pnpm 失败。' }
    & corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重新运行。' }

    $psql = Find-Psql
    if (-not $psql) {
        Write-Host '正在安装 PostgreSQL。请在安装向导中保留默认端口 5432，设置并记住 postgres 密码。'
        Install-WingetPackage 'PostgreSQL.PostgreSQL.16' -Interactive
        $psql = Find-Psql
        if (-not $psql) { throw '未找到 PostgreSQL 客户端，请检查安装并重试。' }
    }
    $envFile = Join-Path $target '.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        $credential = Get-Credential -UserName 'postgres' -Message '输入本机 PostgreSQL 的 postgres 账号及安装时设置的密码'
        if (-not $credential) { throw '需要 PostgreSQL 登录信息。' }
        $password = $credential.GetNetworkCredential().Password
        if ($password -notmatch '^[A-Za-z0-9_.-]+$' -or $credential.UserName -notmatch '^[A-Za-z0-9_]+$') { throw '请使用仅包含英文字母、数字、下划线、点或连字符的数据库密码。' }
        $env:PGPASSWORD = $password
        try {
            $exists = & $psql -w -h 127.0.0.1 -p 5432 -U $credential.UserName -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='patent_etl'"
            if ($LASTEXITCODE -ne 0) { throw '无法连接 PostgreSQL，请确认数据库服务、用户名和密码。' }
            if (($exists | Out-String).Trim() -eq '1') { throw '数据库 patent_etl 已存在。为避免误用已有数据，请联系管理员检查。' }
        } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
        Write-Host '请为工作台设置登录密码，登录账号默认为 admin。输入时密码不会显示。'
        $loginPassword = Read-LoginPassword
        $config = [IO.File]::ReadAllText((Join-Path $target '.env.example'))
        $settings = @{
            CNIPA_PG_HOST = '127.0.0.1'; CNIPA_PG_PORT = '5432'; CNIPA_PG_DB = 'patent_etl'
            CNIPA_PG_USER = $credential.UserName; CNIPA_PG_PASSWORD = $password
            MINIO_ACCESS_KEY = 'patent' + (New-LocalSecret).Substring(0, 10); MINIO_SECRET_KEY = New-LocalSecret
            AUTH_USERNAME = 'admin'; AUTH_PASSWORD = $loginPassword; SESSION_SECRET_KEY = New-LocalSecret
            CLASSIFICATION_STORE = 'postgres'; REDIS_URL = ''
            CNIPA_FTP_USER = ''; CNIPA_FTP_PASSWORD = ''; OPENAI_API_KEY = ''
        }
        foreach ($key in $settings.Keys) { $config = Set-EnvValue $config $key $settings[$key] }
        $config = Configure-UserOptions $config $true
        [IO.File]::WriteAllText($envFile, $config, (New-Object Text.UTF8Encoding $false))
    } else {
        $config = [IO.File]::ReadAllText($envFile)
        if ((Read-Host '检测到已有配置。是否修改 FTP、白名单或 AI 配置？输入 Y 修改，其他内容保留') -match '^[Yy]$') {
            $config = Configure-UserOptions $config
            [IO.File]::WriteAllText($envFile, $config, (New-Object Text.UTF8Encoding $false))
        }
    }
    if ((Get-EnvValue $config 'CLASSIFICATION_STORE') -eq 'redis') {
        Write-Host '现有配置使用 Redis 分类字典。切换到 PostgreSQL 后，分类数据需要单独导入。'
        if ((Read-Host '输入 Y 将现有配置切换到 PostgreSQL，其他内容退出') -notmatch '^[Yy]$') { exit 0 }
        $config = Set-EnvValue $config 'CLASSIFICATION_STORE' 'postgres'
        [IO.File]::WriteAllText($envFile, $config, (New-Object Text.UTF8Encoding $false))
    }
    $pgHost = Get-EnvValue $config 'CNIPA_PG_HOST'
    $pgPort = Get-EnvValue $config 'CNIPA_PG_PORT'
    $pgUser = Get-EnvValue $config 'CNIPA_PG_USER'
    $pgDb = Get-EnvValue $config 'CNIPA_PG_DB'
    if ($pgHost -ne '127.0.0.1' -or $pgPort -ne '5432' -or $pgDb -ne 'patent_etl') { throw '已有配置并非本地安装配置，请检查 .env 后重试。' }
    $env:PGPASSWORD = Get-EnvValue $config 'CNIPA_PG_PASSWORD'
    try {
        $exists = & $psql -w -h $pgHost -p $pgPort -U $pgUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='patent_etl'"
        if ($LASTEXITCODE -ne 0) { throw '无法连接 PostgreSQL，请检查 .env 和数据库服务。' }
        if (($exists | Out-String).Trim() -ne '1') {
            & $psql -w -h $pgHost -p $pgPort -U $pgUser -d postgres -c 'CREATE DATABASE patent_etl'
            if ($LASTEXITCODE -ne 0) { throw '创建数据库失败，请检查 PostgreSQL 权限。' }
        }
    } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    $minioUser = Get-EnvValue $config 'MINIO_ACCESS_KEY'
    $minioPassword = Get-EnvValue $config 'MINIO_SECRET_KEY'
    $binDir = Join-Path $target 'data\local-services'
    $minioData = Join-Path $binDir 'minio-data'
    New-Item -ItemType Directory -Path $minioData -Force | Out-Null
    $minioExe = Join-Path $binDir 'minio.exe'
    $url = 'https://dl.min.io/server/minio/release/windows-amd64/minio.exe'
    if (-not (Test-Path -LiteralPath $minioExe)) {
        Write-Host '正在从 MinIO 官方下载 Windows 服务器程序……'
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $minioExe
    }
    $checksum = (Invoke-WebRequest -UseBasicParsing -Uri ($url + '.sha256sum')).Content.Split(' ')[0].Trim()
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $minioExe).Hash -ne $checksum) { throw "MinIO 文件校验失败，请检查 $minioExe 后重试。" }
    $listener = Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if ($owner.ExecutablePath -ne $minioExe) { throw '9000 端口已被其他程序占用，请检查后重试。' }
    } else {
        $env:MINIO_ROOT_USER = $minioUser
        $env:MINIO_ROOT_PASSWORD = $minioPassword
        try { Start-Process -FilePath $minioExe -ArgumentList @('server', ('"' + $minioData + '"'), '--address', '127.0.0.1:9000', '--console-address', '127.0.0.1:9001') -WindowStyle Hidden } finally {
            Remove-Item Env:MINIO_ROOT_USER -ErrorAction SilentlyContinue
            Remove-Item Env:MINIO_ROOT_PASSWORD -ErrorAction SilentlyContinue
        }
    }
    $env:LOCAL_MINIO_USER = $minioUser
    $env:LOCAL_MINIO_PASSWORD = $minioPassword
    try {
        $js = 'const Minio=require("minio"); const c=new Minio.Client({endPoint:"127.0.0.1",port:9000,useSSL:false,accessKey:process.env.LOCAL_MINIO_USER,secretKey:process.env.LOCAL_MINIO_PASSWORD}); (async()=>{for(let i=0;i<30;i++){try{if(!await c.bucketExists("patent-images"))await c.makeBucket("patent-images","us-east-1");return}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,2000))}}})().catch(e=>{console.error(e.message);process.exit(1)})'
        $encodedJs = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
        & node -e "eval(Buffer.from('$encodedJs','base64').toString())"
        if ($LASTEXITCODE -ne 0) { throw 'MinIO 启动或存储桶初始化失败，请检查端口和配置。' }
    } finally {
        Remove-Item Env:LOCAL_MINIO_USER -ErrorAction SilentlyContinue
        Remove-Item Env:LOCAL_MINIO_PASSWORD -ErrorAction SilentlyContinue
    }
    if ((Read-Host '是否打开 .env 检查或补充配置？输入 Y 打开，其他内容跳过') -match '^[Yy]$') {
        Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $envFile + '"') -Wait
    }
    if ((Read-Host '输入 Y 启动工作台') -notmatch '^[Yy]$') { Write-Host "安装已完成：$target"; exit 0 }
    Write-Host '正在启动工作台，请访问 http://localhost:3000。'
    & corepack pnpm dev
    if ($LASTEXITCODE -ne 0) { throw '启动失败，请检查上方日志和配置。' }
} catch {
    Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
