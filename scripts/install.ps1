[CmdletBinding()]
param(
    [string]$Version = $env:PI_ANTIGRAVITY_VERSION,
    [string]$InstallDir = $(if ($env:PI_ANTIGRAVITY_INSTALL_DIR) { $env:PI_ANTIGRAVITY_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".pi-antigravity-stealth" }),
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repo = "trefeon/pi-antigravity-stealth"
$PackageName = "pi-antigravity-stealth"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Test-CommandExists {
    param([string]$Name)
    return ($null -ne (Get-Command $Name -ErrorAction SilentlyContinue))
}

function Invoke-NativeBestEffort {
    param(
        [string]$Command,
        [string[]]$Arguments
    )
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command @Arguments 2>&1 | Out-Null
    }
    catch {
    }
    finally {
        $ErrorActionPreference = $prevPref
    }
}

function Invoke-NativeChecked {
    param(
        [string]$Command,
        [string[]]$Arguments
    )
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Command exited with code $LASTEXITCODE"
        }
    }
    finally {
        $ErrorActionPreference = $prevPref
    }
}

function Resolve-LatestReleaseTag {
    $latestUrl = "https://github.com/$Repo/releases/latest"
    $request = [System.Net.HttpWebRequest]::Create($latestUrl)
    $request.Method = "GET"
    $request.AllowAutoRedirect = $false
    $request.UserAgent = "$PackageName-installer"
    $request.Timeout = 10000

    $response = $null
    try {
        $response = $request.GetResponse()
    }
    catch [System.Net.WebException] {
        $response = $_.Exception.Response
    }

    if ($null -eq $response) {
        return $null
    }

    try {
        $location = $response.Headers["Location"]
        if ((-not $location) -and ($null -ne $response.ResponseUri)) {
            $location = $response.ResponseUri.AbsoluteUri
        }
        if ($location -and ($location -match "/releases/tag/([^/?#]+)")) {
            return $Matches[1]
        }
    }
    finally {
        $response.Close()
    }
    return $null
}

if ($Uninstall) {
    Write-Output "[i] Uninstalling $PackageName..."
    if (Test-CommandExists "omp") {
        Invoke-NativeBestEffort "omp" @("plugin", "uninstall", $PackageName)
    }
    if (Test-CommandExists "pi") {
        Invoke-NativeBestEffort "pi" @("remove", $InstallDir)
        Invoke-NativeBestEffort "pi" @("remove", "npm:$PackageName")
    }

    $ompLink = Join-Path $env:USERPROFILE ".omp\plugins\node_modules\$PackageName"
    if (Test-Path $ompLink) {
        Remove-Item -Path $ompLink -Recurse -Force -ErrorAction SilentlyContinue
    }

    $gitMarker = Join-Path $InstallDir ".git"
    if ((Test-Path $InstallDir) -and (-not (Test-Path $gitMarker))) {
        Remove-Item -Path $InstallDir -Recurse -Force
        Write-Output "[OK] Removed $InstallDir"
    }
    elseif (Test-Path $gitMarker) {
        Write-Output "[i] Kept git checkout at $InstallDir (unlinked only)."
    }

    Write-Output "[OK] Done. Saved credentials in ~/.omp/agent/agent.db were left untouched."
    exit 0
}

$existingGit = Join-Path $InstallDir ".git"
if (Test-Path $existingGit) {
    Write-Error "[!] Refusing to overwrite git repository at $InstallDir. Run 'git pull' inside it or pass -InstallDir."
    exit 1
}

$tag = ""
$refType = "tag"
if ($Version) {
    if ($Version.StartsWith("v")) {
        $tag = $Version
    }
    else {
        $tag = "v$Version"
    }
}
else {
    $resolvedTag = Resolve-LatestReleaseTag
    if ($resolvedTag) {
        $tag = $resolvedTag
    }
    else {
        Write-Output "[WARN] No GitHub release redirect found; falling back to main branch archive."
        $tag = "main"
        $refType = "branch"
    }
}

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-ag-stealth-" + [System.Guid]::NewGuid().ToString("N"))
$extractDir = Join-Path $tmpRoot "extract"
$archivePath = Join-Path $tmpRoot "archive.zip"

New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

try {
    if ($refType -eq "tag") {
        $assetUrl = "https://github.com/$Repo/releases/download/$tag/$PackageName-$tag.zip"
        $fallbackUrl = "https://github.com/$Repo/archive/refs/tags/$tag.zip"
        Write-Output "[...] Downloading $PackageName $tag from GitHub Releases..."
        try {
            Invoke-WebRequest -Uri $assetUrl -OutFile $archivePath -UseBasicParsing
        }
        catch {
            Write-Output "[i] Release asset unavailable, fetching source archive for $tag..."
            Invoke-WebRequest -Uri $fallbackUrl -OutFile $archivePath -UseBasicParsing
        }
    }
    else {
        $branchUrl = "https://github.com/$Repo/archive/refs/heads/main.zip"
        Write-Output "[...] Downloading $PackageName (main) from GitHub..."
        Invoke-WebRequest -Uri $branchUrl -OutFile $archivePath -UseBasicParsing
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force

    $srcRoot = $null
    if ((Test-Path (Join-Path $extractDir "package.json")) -and (Test-Path (Join-Path $extractDir "src\index.ts"))) {
        $srcRoot = $extractDir
    }
    else {
        $subDirs = Get-ChildItem -Path $extractDir -Directory
        foreach ($d in $subDirs) {
            if ((Test-Path (Join-Path $d.FullName "package.json")) -and (Test-Path (Join-Path $d.FullName "src\index.ts"))) {
                $srcRoot = $d.FullName
                break
            }
        }
    }

    if (-not $srcRoot) {
        throw "Downloaded archive does not contain a valid $PackageName package."
    }

    $pkgJson = Get-Content (Join-Path $srcRoot "package.json") -Raw | ConvertFrom-Json
    $pkgVersion = if ($pkgJson.version) { [string]$pkgJson.version } else { "0.0.0" }

    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path (Join-Path $srcRoot "*") -Destination $InstallDir -Recurse -Force

    $meta = @{
        source      = "github-release"
        repo        = $Repo
        version     = $pkgVersion
        tag         = $tag
        installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $metaPath = Join-Path $InstallDir ".pi-antigravity-install.json"
    $meta | ConvertTo-Json -Depth 4 | Set-Content -Path $metaPath -Encoding UTF8

    Write-Output "[OK] Installed $PackageName v$pkgVersion to $InstallDir"

    $wired = $false
    if (Test-CommandExists "omp") {
        $ompPluginsPkg = Join-Path $env:USERPROFILE ".omp\plugins\package.json"
        if (Test-Path $ompPluginsPkg) {
            $rawPluginsPkg = Get-Content $ompPluginsPkg -Raw -ErrorAction SilentlyContinue
            if ($rawPluginsPkg -and ($rawPluginsPkg -match "`"$PackageName`"")) {
                Invoke-NativeBestEffort "omp" @("plugin", "uninstall", $PackageName)
            }
        }
        Push-Location $InstallDir
        try {
            Invoke-NativeChecked "omp" @("plugin", "link", ".")
        }
        finally {
            Pop-Location
        }
        $wired = $true
        Write-Output "[OK] Linked $PackageName into OMP."
    }

    if (Test-CommandExists "pi") {
        Invoke-NativeBestEffort "pi" @("remove", "npm:$PackageName")
        Invoke-NativeChecked "pi" @("install", $InstallDir)
        $wired = $true
        Write-Output "[OK] Installed $PackageName into Pi."
    }

    if (-not $wired) {
        Write-Output "[WARN] Neither 'omp' nor 'pi' was found on PATH."
        Write-Output "Link manually after installing your agent CLI:"
        Write-Output "  cd `"$InstallDir`"; omp plugin link ."
        Write-Output "  pi install `"$InstallDir`""
    }

    Write-Output ""
    Write-Output "Verify inside OMP/Pi:"
    Write-Output "  omp models google-antigravity"
    Write-Output "  /agy status"
    Write-Output "  /agy update"
}
finally {
    if (Test-Path $tmpRoot) {
        Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
