param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& '.\.venv\Scripts\python.exe' -m uvicorn nisar_backend.api:app --host 127.0.0.1 --port $Port
if ($LASTEXITCODE -ne 0) { throw 'Starting the backend failed.' }

