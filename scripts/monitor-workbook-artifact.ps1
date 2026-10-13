param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Mine,
  [Parameter(Mandatory=$true)][ValidateSet('base','sparse','dense','islands')][string]$Case,
  [Parameter(Mandatory=$true)][string]$ArtifactDir,
  [int]$Rows = 100000,
  [int]$Columns = 200,
  [string]$Parser = '',
  [int]$DeadlineSeconds = 300
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$resultDir = [System.IO.Path]::GetFullPath($ArtifactDir, $taskRoot)
[System.IO.Directory]::CreateDirectory($resultDir) | Out-Null
$stdoutPath = Join-Path $resultDir 'verifier.stdout.log'
$stderrPath = Join-Path $resultDir 'verifier.stderr.log'
$memoryPath = Join-Path $resultDir 'memory.jsonl'
$summaryPath = Join-Path $resultDir 'monitor.json'
if (-not $Parser) { $Parser = Join-Path $taskRoot 'rust/target/release/svn_excel_parser.exe' }
$startInfo = [System.Diagnostics.ProcessStartInfo]::new('node')
$startInfo.WorkingDirectory = $taskRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in @(
  'node_modules/tsx/dist/cli.mjs', 'scripts/verify-workbook-artifact.ts',
  "--base=$([System.IO.Path]::GetFullPath($Base, $taskRoot))",
  "--mine=$([System.IO.Path]::GetFullPath($Mine, $taskRoot))", "--case=$Case",
  "--artifact-dir=$resultDir", "--rows=$Rows", "--columns=$Columns",
  "--parser=$([System.IO.Path]::GetFullPath($Parser, $taskRoot))"
)) { $startInfo.ArgumentList.Add($argument) }
$verifier = [System.Diagnostics.Process]::Start($startInfo)
$stdoutTask = $verifier.StandardOutput.ReadToEndAsync()
$stderrTask = $verifier.StandardError.ReadToEndAsync()
$tracked = [System.Collections.Generic.HashSet[int]]::new()
[void]$tracked.Add($verifier.Id)
$started = [DateTime]::UtcNow
$peaks = @{}
$terminationReason = $null
$aggregatePeak = [long]0
$privatePeak = [long]0
$minimumAvailable = [long]::MaxValue
$writer = [System.IO.StreamWriter]::new($memoryPath, $false, [System.Text.UTF8Encoding]::new($false))
try {
  while ($true) {
    $allProcesses = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)
    do {
      $added = $false
      foreach ($item in $allProcesses) {
        if ($tracked.Contains([int]$item.ParentProcessId) -and -not $tracked.Contains([int]$item.ProcessId)) {
          [void]$tracked.Add([int]$item.ProcessId)
          $added = $true
        }
      }
    } while ($added)
    $processSamples = @()
    $aggregate = [long]0
    $private = [long]0
    foreach ($item in $allProcesses) {
      if (-not $tracked.Contains([int]$item.ProcessId)) { continue }
      $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
      if (-not $process) { continue }
      $sample = [ordered]@{ pid=$item.ProcessId; parentPid=$item.ParentProcessId; name=$item.Name;
        commandLine=$item.CommandLine; workingSetBytes=$process.WorkingSet64; peakWorkingSetBytes=$process.PeakWorkingSet64;
        privateBytes=$process.PrivateMemorySize64; cpuSeconds=$process.CPU }
      $processSamples += $sample
      $aggregate += $process.WorkingSet64
      $private += $process.PrivateMemorySize64
      $key = [string]$item.ProcessId
      if (-not $peaks.ContainsKey($key) -or $sample.peakWorkingSetBytes -gt $peaks[$key].peakWorkingSetBytes) { $peaks[$key] = $sample }
    }
    $available = [long](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024
    $elapsed = ([DateTime]::UtcNow - $started).TotalSeconds
    $aggregatePeak = [Math]::Max($aggregatePeak, $aggregate)
    $privatePeak = [Math]::Max($privatePeak, $private)
    $minimumAvailable = [Math]::Min($minimumAvailable, $available)
    $record = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); elapsedSeconds=$elapsed;
      availablePhysicalBytes=$available; aggregateWorkingSetBytes=$aggregate; aggregatePrivateBytes=$private; processes=$processSamples }
    $writer.WriteLine(($record | ConvertTo-Json -Compress -Depth 6))
    $writer.Flush()
    $verifier.Refresh()
    if ($verifier.HasExited) { break }
    if ($available -lt 1536MB) { $terminationReason='monitor aborted: available physical memory below 1.5GiB'; break }
    if ($elapsed -gt $DeadlineSeconds) { $terminationReason="monitor aborted: deadline ${DeadlineSeconds}s"; break }
    Start-Sleep -Milliseconds 800
  }
} finally {
  $writer.Dispose()
  if ($terminationReason) {
    foreach ($item in ($allProcesses | Sort-Object ParentProcessId -Descending)) {
      if ($tracked.Contains([int]$item.ProcessId)) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  }
  $verifier.WaitForExit(10000) | Out-Null
  if ($verifier.HasExited) {
    [System.IO.File]::WriteAllText($stdoutPath, $stdoutTask.GetAwaiter().GetResult())
    [System.IO.File]::WriteAllText($stderrPath, $stderrTask.GetAwaiter().GetResult())
  }
  $summary = [ordered]@{ startedAt=$started.ToString('o'); elapsedSeconds=([DateTime]::UtcNow-$started).TotalSeconds;
    exitCode=$(if($verifier.HasExited){$verifier.ExitCode}else{$null}); terminationReason=$terminationReason;
    peakObservedAggregateWorkingSetBytes=$aggregatePeak; peakObservedAggregatePrivateBytes=$privatePeak;
    minimumAvailablePhysicalBytes=$minimumAvailable; perProcessPeaks=@($peaks.Values);
    interval='approximately 0.8-2s (CIM overhead included)'; cachePolicy='OS filesystem cache not flushed';
    stdoutPath=$stdoutPath; stderrPath=$stderrPath; memoryPath=$memoryPath }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8
  $summary | ConvertTo-Json -Depth 3
  if ($verifier.HasExited -and $verifier.ExitCode -ne 0) { Get-Content -LiteralPath $stderrPath -Tail 12 }
}
if ($terminationReason -or -not $verifier.HasExited -or $verifier.ExitCode -ne 0) { exit 1 }
