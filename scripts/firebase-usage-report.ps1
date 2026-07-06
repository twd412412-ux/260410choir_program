param(
  [string]$ProjectId = "choir-project-f3b67",
  [string]$BucketName = "choir-project-f3b67.firebasestorage.app",
  [string]$SavePath = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$GiB = 1024.0 * 1024.0 * 1024.0
$FirestoreFreeReadsPerDay = 50000
$FirestoreFreeWritesPerDay = 20000
$FirestoreFreeDeletesPerDay = 20000
$FirestoreStoredFreeGiB = 1
$StorageStoredFreeGiB = 5
$StorageDownloadedFreeGiBPerMonth = 100

# Firestore Standard edition rough USD rates for the current Seoul database.
# Check Firebase/GCP pricing if Google changes regional rates.
$FirestoreReadUsdPer100k = 0.03
$FirestoreWriteUsdPer100k = 0.09
$FirestoreDeleteUsdPer100k = 0.01

function Get-NpxCommand {
  $candidates = @(
    "C:\Program Files\nodejs\npx.cmd",
    "npx.cmd",
    "npx"
  )

  foreach ($candidate in $candidates) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
      return $cmd.Source
    }
  }

  throw "npx was not found. Check Node.js or Firebase CLI setup."
}

function Get-FirebaseLogin {
  $npx = Get-NpxCommand
  $jsonText = & $npx --yes firebase-tools login:list --json
  if ($LASTEXITCODE -ne 0) {
    throw "Firebase CLI login was not found. Run first: npx firebase-tools login"
  }

  $json = $jsonText | ConvertFrom-Json
  if (-not $json.result -or -not $json.result[0].tokens.access_token) {
    throw "Firebase CLI access token was not found. Run first: npx firebase-tools login"
  }

  return @{
    Email = $json.result[0].user.email
    Token = $json.result[0].tokens.access_token
  }
}

function Invoke-GoogleApi([string]$Uri) {
  Invoke-RestMethod -Uri $Uri -Headers @{ Authorization = "Bearer $script:AccessToken" } -Method Get
}

function Convert-ToIsoUtc([datetime]$DateTime) {
  $DateTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

function Get-MonitoringSum([string]$Metric, [int]$Days) {
  $now = (Get-Date).ToUniversalTime()
  $start = Convert-ToIsoUtc $now.AddDays(-$Days)
  $end = Convert-ToIsoUtc $now
  $filter = [uri]::EscapeDataString("metric.type=`"$Metric`"")
  $startParam = [uri]::EscapeDataString($start)
  $endParam = [uri]::EscapeDataString($end)
  $uri = "https://monitoring.googleapis.com/v3/projects/$ProjectId/timeSeries?filter=$filter&interval.startTime=$startParam&interval.endTime=$endParam&aggregation.alignmentPeriod=86400s&aggregation.perSeriesAligner=ALIGN_DELTA&aggregation.crossSeriesReducer=REDUCE_SUM"

  $response = Invoke-GoogleApi $uri
  $total = 0.0
  $points = 0

  foreach ($series in @($response.timeSeries)) {
    foreach ($point in @($series.points)) {
      if ($null -ne $point.value.int64Value) {
        $total += [double]$point.value.int64Value
        $points++
      } elseif ($null -ne $point.value.doubleValue) {
        $total += [double]$point.value.doubleValue
        $points++
      }
    }
  }

  return @{
    Total = $total
    Points = $points
    Series = @($response.timeSeries).Count
  }
}

function Get-MonitoringDailyValues([string]$Metric, [int]$Days) {
  $now = (Get-Date).ToUniversalTime()
  $start = Convert-ToIsoUtc $now.AddDays(-$Days)
  $end = Convert-ToIsoUtc $now
  $filter = [uri]::EscapeDataString("metric.type=`"$Metric`"")
  $startParam = [uri]::EscapeDataString($start)
  $endParam = [uri]::EscapeDataString($end)
  $uri = "https://monitoring.googleapis.com/v3/projects/$ProjectId/timeSeries?filter=$filter&interval.startTime=$startParam&interval.endTime=$endParam&aggregation.alignmentPeriod=86400s&aggregation.perSeriesAligner=ALIGN_DELTA&aggregation.crossSeriesReducer=REDUCE_SUM"

  $response = Invoke-GoogleApi $uri
  $values = @()

  foreach ($series in @($response.timeSeries)) {
    foreach ($point in @($series.points)) {
      $value = 0.0
      if ($null -ne $point.value.int64Value) {
        $value = [double]$point.value.int64Value
      } elseif ($null -ne $point.value.doubleValue) {
        $value = [double]$point.value.doubleValue
      }

      $values += [pscustomobject]@{
        EndTimeKst = ([datetime]$point.interval.endTime).ToUniversalTime().AddHours(9)
        Value = $value
      }
    }
  }

  return $values | Sort-Object EndTimeKst
}

function Get-MonitoringLatest([string]$Metric, [int]$Days = 14) {
  $now = (Get-Date).ToUniversalTime()
  $start = Convert-ToIsoUtc $now.AddDays(-$Days)
  $end = Convert-ToIsoUtc $now
  $filter = [uri]::EscapeDataString("metric.type=`"$Metric`"")
  $startParam = [uri]::EscapeDataString($start)
  $endParam = [uri]::EscapeDataString($end)
  $uri = "https://monitoring.googleapis.com/v3/projects/$ProjectId/timeSeries?filter=$filter&interval.startTime=$startParam&interval.endTime=$endParam"

  $response = Invoke-GoogleApi $uri
  $points = @()

  foreach ($series in @($response.timeSeries)) {
    foreach ($point in @($series.points)) {
      $value = $null
      if ($null -ne $point.value.int64Value) {
        $value = [double]$point.value.int64Value
      } elseif ($null -ne $point.value.doubleValue) {
        $value = [double]$point.value.doubleValue
      }

      if ($null -ne $value) {
        $points += [pscustomobject]@{
          At = ([datetime]$point.interval.endTime).ToUniversalTime()
          Value = $value
        }
      }
    }
  }

  if ($points.Count -eq 0) {
    return @{
      Value = $null
      At = $null
      Series = @($response.timeSeries).Count
    }
  }

  $latestAt = ($points | Sort-Object At -Descending | Select-Object -First 1).At
  $latestTotal = 0.0
  foreach ($point in $points) {
    if ([math]::Abs(($point.At - $latestAt).TotalMinutes) -lt 1) {
      $latestTotal += $point.Value
    }
  }

  return @{
    Value = $latestTotal
    At = $latestAt
    Series = @($response.timeSeries).Count
  }
}

function Format-Count($Value) {
  if ($null -eq $Value) { return "-" }
  return "{0:N0}" -f [double]$Value
}

function Format-Bytes($Bytes) {
  if ($null -eq $Bytes) { return "-" }
  $value = [double]$Bytes
  if ($value -ge $GiB) {
    return ("{0:N2} GiB" -f ($value / $GiB))
  }
  if ($value -ge 1024 * 1024) {
    return ("{0:N1} MB" -f ($value / 1024 / 1024))
  }
  if ($value -ge 1024) {
    return ("{0:N1} KB" -f ($value / 1024))
  }
  return ("{0:N0} B" -f $value)
}

function Format-Usd($Value) {
  return ('$' + ('{0:N2}' -f [double]$Value))
}

function Get-OverFreeTotal($DailyValues, [double]$FreePerDay) {
  $total = 0.0
  foreach ($row in $DailyValues) {
    $total += [math]::Max(0, $row.Value - $FreePerDay)
  }
  return $total
}

$login = Get-FirebaseLogin
$script:AccessToken = $login.Token

$billingEnabled = "unknown"
try {
  $billingInfo = Invoke-GoogleApi "https://cloudbilling.googleapis.com/v1/projects/$ProjectId/billingInfo"
  $billingEnabled = $billingInfo.billingEnabled
} catch {
  $billingEnabled = "not available"
}

$firestoreLocation = "unknown"
$firestoreEdition = "unknown"
try {
  $db = Invoke-GoogleApi "https://firestore.googleapis.com/v1/projects/$ProjectId/databases/(default)"
  $firestoreLocation = $db.locationId
  $firestoreEdition = $db.databaseEdition
} catch {
}

$bucketLocation = "unknown"
$bucketClass = "unknown"
try {
  $bucket = Invoke-GoogleApi "https://storage.googleapis.com/storage/v1/b/$BucketName"
  $bucketLocation = $bucket.location
  $bucketClass = $bucket.storageClass
} catch {
}

$metric = @{
  FirestoreReads = "firestore.googleapis.com/document/read_count"
  FirestoreWrites = "firestore.googleapis.com/document/write_count"
  FirestoreDeletes = "firestore.googleapis.com/document/delete_count"
  StorageDownloaded = "storage.googleapis.com/network/sent_bytes_count"
  StorageUploaded = "storage.googleapis.com/network/received_bytes_count"
  StorageRequests = "storage.googleapis.com/api/request_count"
  FirestoreStored = "firestore.googleapis.com/storage/data_and_index_storage_bytes"
  StorageStored = "storage.googleapis.com/storage/total_bytes"
  StorageObjects = "storage.googleapis.com/storage/object_count"
}

$periods = @(1, 7, 30)
$periodRows = @()
foreach ($days in $periods) {
  $periodRows += [pscustomobject]@{
    Days = $days
    Reads = (Get-MonitoringSum $metric.FirestoreReads $days).Total
    Writes = (Get-MonitoringSum $metric.FirestoreWrites $days).Total
    Deletes = (Get-MonitoringSum $metric.FirestoreDeletes $days).Total
    StorageDownloaded = (Get-MonitoringSum $metric.StorageDownloaded $days).Total
    StorageUploaded = (Get-MonitoringSum $metric.StorageUploaded $days).Total
    StorageRequests = (Get-MonitoringSum $metric.StorageRequests $days).Total
  }
}

$firestoreStored = Get-MonitoringLatest $metric.FirestoreStored
$storageStored = Get-MonitoringLatest $metric.StorageStored
$storageObjects = Get-MonitoringLatest $metric.StorageObjects

$dailyReads = Get-MonitoringDailyValues $metric.FirestoreReads 30
$dailyWrites = Get-MonitoringDailyValues $metric.FirestoreWrites 30
$dailyDeletes = Get-MonitoringDailyValues $metric.FirestoreDeletes 30

$billableReads = Get-OverFreeTotal $dailyReads $FirestoreFreeReadsPerDay
$billableWrites = Get-OverFreeTotal $dailyWrites $FirestoreFreeWritesPerDay
$billableDeletes = Get-OverFreeTotal $dailyDeletes $FirestoreFreeDeletesPerDay
$firestoreOpCostUsd = ($billableReads / 100000.0 * $FirestoreReadUsdPer100k) +
  ($billableWrites / 100000.0 * $FirestoreWriteUsdPer100k) +
  ($billableDeletes / 100000.0 * $FirestoreDeleteUsdPer100k)

$storage30d = ($periodRows | Where-Object { $_.Days -eq 30 }).StorageDownloaded
$storageDownloadedGiB = $storage30d / $GiB
$storageFreeRemainingGiB = [math]::Max(0, $StorageDownloadedFreeGiBPerMonth - $storageDownloadedGiB)

$topReadDays = $dailyReads |
  Sort-Object Value -Descending |
  Select-Object -First 5 |
  ForEach-Object {
    $over = [math]::Max(0, $_.Value - $FirestoreFreeReadsPerDay)
    "| {0} | {1} | {2} |" -f $_.EndTimeKst.ToString("yyyy-MM-dd"), (Format-Count $_.Value), (Format-Count $over)
  }

$lines = @()
$lines += "# Firebase Usage Quick Report"
$lines += ""
$lines += "- Generated: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss K'))"
$lines += "- Account: $($login.Email)"
$lines += "- Project: $ProjectId"
$lines += "- Billing enabled: $billingEnabled"
$lines += "- Firestore: $firestoreLocation / $firestoreEdition"
$lines += "- Storage: $BucketName / $bucketLocation / $bucketClass"
$lines += ""
$lines += "## Current Storage"
$lines += ""
$lines += "| Item | Current | Free quota |"
$lines += "| --- | ---: | ---: |"
$lines += "| Firestore data + indexes | $(Format-Bytes $firestoreStored.Value) | $FirestoreStoredFreeGiB GiB |"
$lines += "| Storage files | $(Format-Bytes $storageStored.Value) | $StorageStoredFreeGiB GiB-month |"
$lines += "| Storage object count | $(Format-Count $storageObjects.Value) | - |"
$lines += ""
$lines += "## Usage By Period"
$lines += ""
$lines += "| Period | Firestore reads | Writes | Deletes | Storage downloaded | Storage uploaded | Storage API requests |"
$lines += "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
foreach ($row in $periodRows) {
  $label = if ($row.Days -eq 1) { "Last 24h" } else { "Last $($row.Days)d" }
  $lines += "| $label | $(Format-Count $row.Reads) | $(Format-Count $row.Writes) | $(Format-Count $row.Deletes) | $(Format-Bytes $row.StorageDownloaded) | $(Format-Bytes $row.StorageUploaded) | $(Format-Count $row.StorageRequests) |"
}
$lines += ""
$lines += "## Rough Cost Estimate"
$lines += ""
$lines += "- Firestore billable reads after daily free quota, last 30d: $(Format-Count $billableReads)"
$lines += "- Firestore billable writes after daily free quota, last 30d: $(Format-Count $billableWrites)"
$lines += "- Firestore billable deletes after daily free quota, last 30d: $(Format-Count $billableDeletes)"
$lines += "- Firestore operation cost estimate: $(Format-Usd $firestoreOpCostUsd)"
$lines += "- Storage downloaded, last 30d: $(Format-Bytes $storage30d) / free quota $StorageDownloadedFreeGiBPerMonth GiB"
$lines += "- Storage download free headroom: $('{0:N2}' -f $storageFreeRemainingGiB) GiB"
$lines += ""
$lines += "## Top Firestore Read Days"
$lines += ""
$lines += "| Date (KST) | Reads | Over daily free quota |"
$lines += "| --- | ---: | ---: |"
$lines += $topReadDays
$lines += ""
$lines += "> Cost is a rough estimate from Cloud Monitoring metrics and the rates in this script. Use Firebase/GCP Billing as the final source."
$lines += "> This script does not read app data collections. It only queries Monitoring/Billing APIs."

$report = $lines -join [Environment]::NewLine
Write-Output $report

if ($SavePath.Trim()) {
  $parent = Split-Path -Parent $SavePath
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Set-Content -Path $SavePath -Value $report -Encoding UTF8
  Write-Output ""
  Write-Output "Saved: $SavePath"
}
