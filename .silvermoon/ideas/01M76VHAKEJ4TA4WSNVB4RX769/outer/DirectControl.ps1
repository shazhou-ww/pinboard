param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Prepare', 'Migrate', 'Provision', 'Snapshot', 'ReadProtected')]
  [string] $Mode,
  [string] $Name = 'after-smoke'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$account = '92c3c4fdcc84a1590555bccf4f111de2'
$database = '9f15fd50-e103-459f-9f3f-9db3036f91de'
$base = "https://api.cloudflare.com/client/v4/accounts/$account"
$directory = Join-Path (Get-Location) '.dev.vars.ipns-recovery'
$manifestPath = Join-Path $directory 'state.json'
$masterPath = Join-Path $directory 'master-v1.dpapi'
$token = $null
$headers = $null

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw $Message }
}
function Get-Digest([byte[]] $Bytes) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Read-State {
  if (Test-Path -LiteralPath $manifestPath) {
    return Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  }
  return [pscustomobject]@{}
}
function Save-State($State) {
  $State | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}
function Set-State($State, [string] $Property, $Value) {
  $State | Add-Member -NotePropertyName $Property -NotePropertyValue $Value -Force
}
function Initialize-Directory {
  if (-not (Test-Path -LiteralPath $directory)) {
    [void](New-Item -ItemType Directory -Path $directory)
    $acl = Get-Acl -LiteralPath $directory
    $acl.SetAccessRuleProtection($true, $false)
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    foreach ($sid in @($userSid, $systemSid)) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
  }
  $current = Get-Acl -LiteralPath $directory
  Assert-True $current.AreAccessRulesProtected '恢复目录继承权限未关闭。'
  $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
  foreach ($entry in $current.Access) {
    $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    Assert-True ($allowed -contains $sid) '恢复目录包含未经批准的 ACL 主体。'
  }
  & git check-ignore --quiet -- '.dev.vars.ipns-recovery'
  Assert-True ($LASTEXITCODE -eq 0) '恢复目录未被既有 Git ignore 规则保护。'
}
function Save-Protected([string] $FileName, [byte[]] $Bytes) {
  $path = Join-Path $directory "$FileName.dpapi"
  Assert-True (-not (Test-Path -LiteralPath $path)) '不覆盖既有恢复文件。'
  $sealed = [Security.Cryptography.ProtectedData]::Protect(
    $Bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($path, $sealed)
  $opened = [Security.Cryptography.ProtectedData]::Unprotect(
    [IO.File]::ReadAllBytes($path), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try {
    Assert-True ((Get-Digest $Bytes) -eq (Get-Digest $opened)) 'DPAPI 持久化恢复校验失败。'
    return [pscustomobject]@{ file = "$FileName.dpapi"; bytes = $Bytes.Length; sha256 = Get-Digest $Bytes; roundtrip = $true }
  } finally { [Array]::Clear($opened, 0, $opened.Length) }
}
function Invoke-Cf([string] $Method, [string] $Path, $Body = $null) {
  $parameters = @{
    Uri = "$base$Path"; Method = $Method; Headers = $headers; TimeoutSec = 60
  }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 15 -Compress))
  }
  try { $response = Invoke-RestMethod @parameters }
  catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    throw "Cloudflare $Method 请求失败，HTTP $status；响应内容及 credential 已抑制。"
  }
  Assert-True ($response.success -eq $true) 'Cloudflare 请求未返回 success；不输出原始响应。'
  return $response.result
}
function Query([string] $Sql) {
  return Invoke-Cf 'Post' "/d1/database/$database/query" @{ sql = $Sql }
}
function Export-Protected([string] $Label) {
  $poll = @{ output_format = 'polling' }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  do {
    $result = Invoke-Cf 'Post' "/d1/database/$database/export" $poll
    if ($result.status -eq 'error') { throw 'D1 export 失败，未输出数据库或下载地址。' }
    if ($result.status -eq 'complete') { break }
    Assert-True ($watch.Elapsed.TotalSeconds -lt 60) 'D1 export 超过本轮 60 秒窗口；停止继续轮询。'
    Assert-True ([bool]$result.at_bookmark) 'D1 export 未返回稳定 bookmark。'
    $poll = @{ output_format = 'polling'; current_bookmark = $result.at_bookmark }
    Start-Sleep -Milliseconds 250
  } while ($true)
  $uri = [Uri]$result.result.signed_url
  Assert-True ($uri.Scheme -eq 'https' -and
    ($uri.Host.EndsWith('.cloudflare.com') -or $uri.Host.EndsWith('.r2.cloudflarestorage.com'))) 'D1 导出下载域名不在允许列表。'
  $download = Invoke-WebRequest -UseBasicParsing -Uri $uri.AbsoluteUri -TimeoutSec 60
  $stream = New-Object IO.MemoryStream
  try {
    $download.RawContentStream.CopyTo($stream)
    Assert-True ($stream.Length -le 67108864) '导出超过本轮内存上限。'
    $bytes = $stream.ToArray()
    try { $proof = Save-Protected $Label $bytes }
    finally { [Array]::Clear($bytes, 0, $bytes.Length) }
  } finally { $stream.Dispose() }
  return [pscustomobject]@{ bookmark = $result.at_bookmark; encrypted = $proof; milliseconds = $watch.ElapsedMilliseconds }
}

if ($Mode -eq 'ReadProtected') {
  Assert-True ($env:PINBOARD_IPNS_RECOVERY_PIPE -eq '1') '仅允许受控子进程 pipe 恢复，禁止工具直接输出明文。'
  Assert-True ($Name -match '^[a-z0-9-]+$') '恢复名称无效。'
  $opened = [Security.Cryptography.ProtectedData]::Unprotect(
    [IO.File]::ReadAllBytes((Join-Path $directory "$Name.dpapi")),
    $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try { [Console]::OpenStandardOutput().Write($opened, 0, $opened.Length) }
  finally { [Array]::Clear($opened, 0, $opened.Length) }
  exit 0
}

try {
  $token = (cfg get --remote CLOUDFLARE_API_TOKEN | Out-String).Trim()
  Assert-True ($LASTEXITCODE -eq 0 -and [bool]$token -and -not $token.Contains("`n")) 'cfg credential 未安全取得。'
  $headers = @{ Authorization = "Bearer $token" }
  $target = Invoke-Cf 'Get' "/d1/database/$database"
  Assert-True ($target.uuid -eq $database -and $target.name -eq 'pinboard' -and $target.version -eq 'production') '生产 D1 目标不匹配。'
  $state = Read-State
  if ($Mode -eq 'Prepare') {
    Initialize-Directory
    $schema = Query "SELECT name,sql FROM sqlite_master WHERE name IN ('publication_ipns','publication_ipns_renewal');"
    Assert-True (@($schema[0].results).Count -eq 0) '0010 schema 已存在；停止而非重放迁移。'
    $history = Query 'SELECT name,applied_at FROM d1_migrations ORDER BY id;'
    Assert-True (@($history[0].results | Where-Object { $_.name -eq '0010_publication_ipns.sql' }).Count -eq 0) '0010 已在迁移历史中。'
    $bookmark = Invoke-Cf 'Get' "/d1/database/$database/time_travel/bookmark"
    Set-State $state 'account' $account
    Set-State $state 'database' $database
    Set-State $state 'prepared_at' ([DateTime]::UtcNow.ToString('o'))
    Set-State $state 'pre_bookmark' $bookmark.bookmark
    Set-State $state 'history_before' @($history[0].results)
    Set-State $state 'pre_export' (Export-Protected 'before-0010')
    Save-State $state
    $state | ConvertTo-Json -Depth 12
  } elseif ($Mode -eq 'Migrate') {
    Initialize-Directory
    Assert-True ([bool]$state.pre_export.encrypted.roundtrip) '缺少已验证的迁移前加密备份。'
    $schema = Query "SELECT name FROM sqlite_master WHERE name IN ('publication_ipns','publication_ipns_renewal');"
    Assert-True (@($schema[0].results).Count -eq 0) 'schema 已存在或部分存在；停止而非覆盖。'
    $history = Query "SELECT name FROM d1_migrations WHERE name='0010_publication_ipns.sql';"
    Assert-True (@($history[0].results).Count -eq 0) '0010 历史已存在。'
    $sql = [IO.File]::ReadAllText((Join-Path (Get-Location) 'apps\worker\migrations\0010_publication_ipns.sql'))
    Set-State $state 'migration_sha256' (Get-Digest ([Text.Encoding]::UTF8.GetBytes($sql)))
    $null = Query $sql
    $verified = Query "SELECT name,type,sql FROM sqlite_master WHERE name IN ('publication_ipns','publication_ipns_renewal') ORDER BY name; SELECT count(*) AS bindings FROM publication_ipns;"
    Assert-True (@($verified[0].results).Count -eq 2 -and $verified[1].results[0].bindings -eq 0) '0010 schema/空表核对未通过。'
    $null = Query "INSERT INTO d1_migrations(name) VALUES ('0010_publication_ipns.sql');"
    Set-State $state 'migration_at' ([DateTime]::UtcNow.ToString('o'))
    Set-State $state 'schema_after' @($verified[0].results)
    Set-State $state 'bindings_after_migration' 0
    Save-State $state
    $state | ConvertTo-Json -Depth 12
  } elseif ($Mode -eq 'Provision') {
    Initialize-Directory
    $check = Query "SELECT count(*) AS bindings FROM publication_ipns; SELECT name FROM d1_migrations WHERE name='0010_publication_ipns.sql';"
    Assert-True (@($check[1].results).Count -eq 1) '0010 未确认，不能触发 secret 部署。'
    $before = @(Invoke-Cf 'Get' '/workers/scripts/pinboard/secrets')
    Assert-True (-not @($before | Where-Object { $_.name -eq 'IPNS_MASTER_KEY' }).Count) 'master 已存在，不能盲目替换。'
    $settings = Invoke-Cf 'Get' '/workers/scripts/pinboard/settings'
    Assert-True (@($settings.bindings | Where-Object { $_.type -eq 'd1' -and $_.id -eq $database }).Count -eq 1) 'Worker DB 绑定不匹配。'
    if (-not (Test-Path -LiteralPath $masterPath)) {
      $bytes = New-Object byte[] 32
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      try { $null = Save-Protected 'master-v1' $bytes }
      finally { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
    $master = [Security.Cryptography.ProtectedData]::Unprotect(
      [IO.File]::ReadAllBytes($masterPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
      Assert-True ($master.Length -eq 32) 'master 备份长度不正确。'
      $hex = ([BitConverter]::ToString($master)).Replace('-', '').ToLowerInvariant()
      $null = Invoke-Cf 'Put' '/workers/scripts/pinboard/secrets' @{
        name = 'IPNS_MASTER_KEY'; type = 'secret_text'; text = $hex
      }
    } finally { [Array]::Clear($master, 0, $master.Length); $hex = $null }
    $after = @(Invoke-Cf 'Get' '/workers/scripts/pinboard/secrets')
    foreach ($secret in $before) {
      Assert-True (@($after | Where-Object { $_.name -eq $secret.name }).Count -eq 1) '既有 secret 元数据未保持。'
    }
    Assert-True (@($after | Where-Object { $_.name -eq 'IPNS_MASTER_KEY' }).Count -eq 1) 'master 未配置。'
    $health = Invoke-WebRequest -UseBasicParsing -Uri 'https://pinboard.shazhou.work/api/health' -TimeoutSec 30
    Assert-True ($health.StatusCode -eq 200) 'secret 更新后健康检查失败。'
    $deployments = Invoke-Cf 'Get' '/workers/scripts/pinboard/deployments'
    Set-State $state 'master_provisioned_at' ([DateTime]::UtcNow.ToString('o'))
    Set-State $state 'master_backup' 'master-v1.dpapi'
    Set-State $state 'secret_names_after' @($after | ForEach-Object { $_.name })
    $latest = $deployments.deployments[0]
    Set-State $state 'secret_deployment' ([pscustomobject]@{
      id = $latest.id; created_on = $latest.created_on; source = $latest.source; versions = $latest.versions
    })
    Save-State $state
    [pscustomobject]@{
      provisioned_at = $state.master_provisioned_at; protected_backup = $state.master_backup
      preserved_secret_names = $state.secret_names_after; health = 200
      deployment = $state.secret_deployment
    } | ConvertTo-Json -Depth 8
  } elseif ($Mode -eq 'Snapshot') {
    Initialize-Directory
    Assert-True ($Name -match '^[a-z0-9-]+$') '快照名称无效。'
    $snapshot = Export-Protected $Name
    Set-State $state $Name $snapshot
    Save-State $state
    $snapshot | ConvertTo-Json -Depth 8
  }
} finally {
  $headers = $null
  $token = $null
}
