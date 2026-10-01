# Sends the recorder to a server and starts it. Run from the recorder folder on the school laptop:
#
#   powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 -Server 203.0.113.10
#
# Needs: the server's first-boot setup finished (deploy\cloud-init), and the SSH key made for it.
# Optional: -Bench also uploads the load-test tools (fake tutor + scripts) and the LiveKit settings for it.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Key = "$env:USERPROFILE\.ssh\eduprime-recorder-test",
  [switch]$Bench
)
# "Continue", not "Stop": ssh/scp print harmless notices on stderr (e.g. "added to known hosts"), which
# PowerShell 5 would otherwise turn into fatal errors. Real failures are caught by the exit-code checks below.
$ErrorActionPreference = "Continue"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$ssh = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-o", "LogLevel=ERROR")
$remote = "root@$Server"
function Remote($cmd) { & ssh @ssh $remote $cmd; if ($LASTEXITCODE -ne 0) { throw "remote command failed: $cmd" } }

Write-Host "1/4  Waiting for the server's first-boot setup to finish..."
for ($i = 0; $i -lt 60; $i++) {
  & ssh @ssh $remote "test -f /opt/eduprime-recorder/.setup-done && docker --version" 2>$null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 10
}
if ($LASTEXITCODE -ne 0) { throw "The server did not finish its first-boot setup (is the cloud-config text pasted in?)." }

Write-Host "2/4  Packing and sending the recorder code..."
$tar = Join-Path $env:TEMP "recorder-src.tgz"
Push-Location $repo
tar -czf $tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=.stage --exclude=out --exclude=spool --exclude=tools --exclude=".env" --exclude="deploy/bench/loadpub-linux-amd64" --exclude="deploy/cloud-init.generated.yaml" .
Pop-Location
& scp @ssh $tar "${remote}:/tmp/recorder-src.tgz"
if ($LASTEXITCODE -ne 0) { throw "could not copy the code to the server" }
Remote "rm -rf /opt/eduprime-recorder/src && mkdir -p /opt/eduprime-recorder/src && tar xzf /tmp/recorder-src.tgz -C /opt/eduprime-recorder/src && mkdir -p /opt/eduprime-recorder/src/spool /opt/eduprime-recorder/src/out && chown -R 1001:1001 /opt/eduprime-recorder/src/spool /opt/eduprime-recorder/src/out"

Write-Host "3/4  Building the recorder on the server (takes a few minutes the first time)..."
Remote "cd /opt/eduprime-recorder/src && docker build -f Dockerfile.server -t eduprime-recorder:server ."

if ($Bench) {
  Write-Host "     Uploading the load-test tools..."
  $linux = Join-Path $repo "deploy\bench\loadpub-linux-amd64"
  if (-not (Test-Path $linux)) { throw "Missing $linux (cross-compile tools/loadpub for linux first)." }
  Remote "mkdir -p /opt/eduprime-recorder/bench"
  & scp @ssh $linux "${remote}:/opt/eduprime-recorder/bench/loadpub"
  & scp @ssh (Join-Path $repo "deploy\bench\bench.mjs") (Join-Path $repo "deploy\bench\make-media.sh") "${remote}:/opt/eduprime-recorder/bench/"
  Remote "chmod +x /opt/eduprime-recorder/bench/loadpub /opt/eduprime-recorder/bench/make-media.sh && sh /opt/eduprime-recorder/bench/make-media.sh"
}

Write-Host "4/4  Done building. Next: put the settings in /opt/eduprime-recorder/src/deploy/.env and run:"
Write-Host "       cd /opt/eduprime-recorder/src && docker compose -f deploy/docker-compose.yml up -d"
Write-Host "     Check it:  ssh -i $Key $remote 'curl -s http://127.0.0.1:8787/healthz'"
