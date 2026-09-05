#/usr/bin/env pwsh
# Runs the full workload suite against one VM build and appends SUMMARY JSON lines.
# Usage: pwsh bench/measure-suite.ps1 <vm-path> <out-jsonl> [runs]
param(
    [Parameter(Mandatory=$true)][string]$vm,
    [Parameter(Mandatory=$true)][string]$out,
    [int]$runs = 6
)
$workloads = @(
    'w1-many-sprites','w2-interpreter','w3-clone-storm','w4-sensing-edge',
    'w4b-frame-overhead','w5-broadcast','w6-list-head','w7-string-join'
)
foreach ($w in $workloads) {
    $line = node --expose-gc bench/run-workload.js $w --vm $vm --runs $runs 2>$null | Select-String '^SUMMARY ' | ForEach-Object { $_.Line.Substring(8) }
    if (-not $line) {
        Write-Host "FAILED: $w"
        continue
    }
    $obj = $line | ConvertFrom-Json
    $obj | Add-Member -NotePropertyName build -NotePropertyValue $vm -Force
    ($obj | ConvertTo-Json -Compress) | Add-Content $out
    Write-Host "$($obj.workload): median=$($obj.median) min=$($obj.min) max=$($obj.max)"
}
Write-Host "done -> $out"
