$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
$previousPythonPath = $env:PYTHONPATH
try {
    python -m pip install --target .deps -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    $env:PYTHONPATH = Join-Path $PSScriptRoot '.deps'
    python -m PyInstaller --noconfirm --clean --onefile --windowed --name ChatBridge --add-data '../extension;extension' --add-data 'adapter.js;.' --distpath dist --workpath build app.py
    if ($LASTEXITCODE -ne 0) { throw 'Executable build failed' }
    Copy-Item -LiteralPath README.md -Destination dist/README.md
    Copy-Item -LiteralPath THIRD_PARTY_NOTICES.txt -Destination dist/THIRD_PARTY_NOTICES.txt
    Copy-Item -LiteralPath 'Set up logins.cmd' -Destination 'dist/Set up logins.cmd'
    Compress-Archive -Path dist/ChatBridge.exe,dist/README.md,dist/THIRD_PARTY_NOTICES.txt,'dist/Set up logins.cmd' -DestinationPath dist/ChatBridge-Windows.zip -Force
} finally {
    $env:PYTHONPATH = $previousPythonPath
    Pop-Location
}
