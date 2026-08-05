param(
  [string]$ProjectId = 'choir-project-f3b67',
  [string]$FirebaseCommand = '',
  [string]$BackupDirectory = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$CatalogVersion = 1
$ShardCounts = @{ singer = 2; orchestra = 8 }

function Resolve-FirebaseCommand {
  if ($FirebaseCommand) {
    if (-not (Test-Path -LiteralPath $FirebaseCommand)) { throw "Firebase CLI was not found: $FirebaseCommand" }
    return $FirebaseCommand
  }
  $pathCommand = Get-Command firebase.cmd -ErrorAction SilentlyContinue
  if (-not $pathCommand) { $pathCommand = Get-Command firebase -ErrorAction SilentlyContinue }
  if ($pathCommand) { return $pathCommand.Source }

  $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  $cached = Get-ChildItem -LiteralPath $npxRoot -Recurse -Filter firebase.cmd -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($cached) { return $cached.FullName }
  throw 'Firebase CLI was not found. Install firebase-tools or pass -FirebaseCommand.'
}

function Get-FirebaseAccessToken {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $FirebaseCommand projects:list --json 1>$null 2>$null
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($exitCode -ne 0) { throw "Firebase CLI authentication refresh failed (exit $exitCode): $FirebaseCommand" }

  $configPath = Join-Path $env:USERPROFILE '.config\configstore\firebase-tools.json'
  $config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
  $token = [string]$config.tokens.access_token
  if (-not $token) { throw 'Firebase access token was not found.' }
  return $token
}

function Get-Sha256Hex([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-ScoreKind($ItemValue) {
  $kind = [string]$ItemValue.mapValue.fields.scoreKind.stringValue
  if ($kind -eq 'orchestra') { return 'orchestra' }
  return 'singer'
}

function Get-ShardIndex([string]$Id, [int]$Count) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Id)
    $hash = $sha.ComputeHash($bytes)
    $value = ([int]$hash[0] * 256) + [int]$hash[1]
    return $value % $Count
  } finally {
    $sha.Dispose()
  }
}

function New-IntegerValue([int]$Value) {
  return @{ integerValue = [string]$Value }
}

function New-StringValue([string]$Value) {
  return @{ stringValue = $Value }
}

if (-not $BackupDirectory) {
  $workspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $BackupDirectory = Join-Path $workspaceRoot 'firebase-backups'
}
[System.IO.Directory]::CreateDirectory($BackupDirectory) | Out-Null

$FirebaseCommand = Resolve-FirebaseCommand
$token = Get-FirebaseAccessToken
$headers = @{ Authorization = "Bearer $token" }
$legacyUri = "https://firestore.googleapis.com/v1/projects/$ProjectId/databases/(default)/documents/settings/scores"
$legacyResponse = Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $legacyUri
$legacy = $legacyResponse.Content | ConvertFrom-Json

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $BackupDirectory "scores-before-catalog-migration-$stamp.json"
[System.IO.File]::WriteAllText($backupPath, $legacyResponse.Content, [System.Text.UTF8Encoding]::new($false))

$shards = [ordered]@{}
foreach ($kind in @('singer', 'orchestra')) {
  for ($index = 0; $index -lt $ShardCounts[$kind]; $index++) {
    $id = '{0}_{1:d2}' -f $kind, $index
    $shards[$id] = [ordered]@{}
  }
}

$counts = @{ singer = 0; orchestra = 0 }
$ids = [System.Collections.Generic.List[string]]::new()
$itemProperties = @($legacy.fields.items.mapValue.fields.PSObject.Properties)
foreach ($property in $itemProperties) {
  $id = [string]$property.Name
  $kind = Get-ScoreKind $property.Value
  $index = Get-ShardIndex $id $ShardCounts[$kind]
  $shardId = '{0}_{1:d2}' -f $kind, $index
  $shards[$shardId][$id] = $property.Value
  $counts[$kind]++
  $ids.Add($id)
}
$sortedIds = @($ids | Sort-Object)
$idDigest = Get-Sha256Hex ($sortedIds -join "`n")
$now = (Get-Date).ToUniversalTime().ToString('o')

$confirmLegacy = Invoke-RestMethod -Headers $headers -Uri $legacyUri
if ([string]$confirmLegacy.updateTime -ne [string]$legacy.updateTime) {
  throw 'The score list changed while preparing migration. No catalog data was written; run the script again.'
}

$writes = [System.Collections.Generic.List[object]]::new()
foreach ($entry in $shards.GetEnumerator()) {
  $shardId = [string]$entry.Key
  $kind = if ($shardId.StartsWith('orchestra_')) { 'orchestra' } else { 'singer' }
  $index = [int]$shardId.Substring($shardId.Length - 2)
  $writes.Add(@{
    update = @{
      name = "projects/$ProjectId/databases/(default)/documents/scoreCatalog/$shardId"
      fields = @{
        version = New-IntegerValue $CatalogVersion
        kind = New-StringValue $kind
        shard = New-IntegerValue $index
        items = @{ mapValue = @{ fields = $entry.Value } }
        updatedAt = New-StringValue $now
        updatedById = New-StringValue 'codex-migration'
        updatedByName = New-StringValue '관리자'
      }
    }
  })

  $shardJson = $entry.Value | ConvertTo-Json -Depth 100 -Compress
  $shardBytes = [System.Text.UTF8Encoding]::new($false).GetByteCount($shardJson)
  if ($shardBytes -gt 850000) {
    throw "Score catalog shard $shardId is too large ($shardBytes bytes). No catalog data was written."
  }
}

$writes.Add(@{
  update = @{
    name = "projects/$ProjectId/databases/(default)/documents/scoreCatalog/_meta"
    fields = @{
      version = New-IntegerValue $CatalogVersion
      count = New-IntegerValue $sortedIds.Count
      counts = @{ mapValue = @{ fields = @{
        singer = New-IntegerValue $counts.singer
        orchestra = New-IntegerValue $counts.orchestra
      } } }
      idDigest = New-StringValue $idDigest
      shardCounts = @{ mapValue = @{ fields = @{
        singer = New-IntegerValue $ShardCounts.singer
        orchestra = New-IntegerValue $ShardCounts.orchestra
      } } }
      sourceUpdatedAt = New-StringValue ([string]$legacy.fields.updatedAt.stringValue)
      migratedAt = New-StringValue $now
      updatedAt = New-StringValue $now
      updatedById = New-StringValue 'codex-migration'
      updatedByName = New-StringValue '관리자'
    }
  }
})

$summary = [pscustomobject]@{
  backup = $backupPath
  backupSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath).Hash
  total = $sortedIds.Count
  singer = $counts.singer
  orchestra = $counts.orchestra
  idDigest = $idDigest
}
if ($DryRun) {
  $summary | Add-Member -NotePropertyName dryRun -NotePropertyValue $true
  $summary | ConvertTo-Json -Compress
  return
}

$databaseBase = "https://firestore.googleapis.com/v1/projects/$ProjectId/databases/(default)"
$beginUri = "$databaseBase/documents:beginTransaction"
$beginBody = @{ options = @{ readWrite = @{} } } | ConvertTo-Json -Depth 10 -Compress
$transaction = (Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Uri $beginUri -Body $beginBody).transaction
if (-not $transaction) { throw 'Could not begin the score catalog migration transaction.' }

$transactionLegacyUri = $legacyUri + '?transaction=' + [Uri]::EscapeDataString([string]$transaction)
$transactionLegacy = Invoke-RestMethod -Headers $headers -Uri $transactionLegacyUri
if ([string]$transactionLegacy.updateTime -ne [string]$legacy.updateTime) {
  $rollbackUri = "$databaseBase/documents:rollback"
  $rollbackBody = @{ transaction = $transaction } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Uri $rollbackUri -Body $rollbackBody | Out-Null
  throw 'The score list changed before migration commit. No catalog data was written; run the script again.'
}

$commitUri = "$databaseBase/documents:commit"
$body = @{ writes = @($writes); transaction = $transaction } | ConvertTo-Json -Depth 100 -Compress
$commit = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Uri $commitUri -Body $body

$verifiedIds = [System.Collections.Generic.List[string]]::new()
$verifiedCounts = @{ singer = 0; orchestra = 0 }
foreach ($entry in $shards.GetEnumerator()) {
  $shardId = [string]$entry.Key
  $uri = "https://firestore.googleapis.com/v1/projects/$ProjectId/databases/(default)/documents/scoreCatalog/$shardId"
  $doc = Invoke-RestMethod -Headers $headers -Uri $uri
  $kind = [string]$doc.fields.kind.stringValue
  foreach ($property in @($doc.fields.items.mapValue.fields.PSObject.Properties)) {
    $verifiedIds.Add([string]$property.Name)
    $verifiedCounts[$kind]++
  }
}
$verifiedSortedIds = @($verifiedIds | Sort-Object)
$verifiedDigest = Get-Sha256Hex ($verifiedSortedIds -join "`n")
if ($verifiedSortedIds.Count -ne $sortedIds.Count -or $verifiedDigest -ne $idDigest) {
  throw 'Catalog verification failed. The legacy score document remains unchanged.'
}

[pscustomobject]@{
  backup = $summary.backup
  backupSha256 = $summary.backupSha256
  commitTime = $commit.commitTime
  total = $verifiedSortedIds.Count
  singer = $verifiedCounts.singer
  orchestra = $verifiedCounts.orchestra
  idDigest = $verifiedDigest
  legacyUnchanged = $true
} | ConvertTo-Json -Compress
