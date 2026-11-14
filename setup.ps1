$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Creating the Python environment failed.' }
}
& '.\.venv\Scripts\python.exe' -m pip install -e '.[test]'
if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed.' }

