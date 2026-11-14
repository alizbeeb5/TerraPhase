param(
    [string]$SourceFile = (Join-Path $env:USERPROFILE 'Downloads\NISAR_L2_PR_GCOV_035_040_D_084_4005_DHDH_A_20261107T234445_20261107T234518_P05036_N_F_J_001.h5')
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& '.\.venv\Scripts\python.exe' -m nisar_backend.cli prepare $SourceFile --polarizations HHHH HVHV
if ($LASTEXITCODE -ne 0) { throw 'Preparing the GCOV scene failed.' }

