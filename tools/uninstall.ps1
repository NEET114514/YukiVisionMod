$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PackageRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Test-GameDir {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
    $hook = Join-Path $Dir "resources\install-hooks.js"
    $exe = Get-ChildItem -LiteralPath $Dir -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    return ($null -ne $exe) -and (Test-Path $hook)
}

function Select-GameDir {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select the game folder that contains the exe file."
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        return $dialog.SelectedPath
    }
    throw "No game folder selected. Uninstall canceled."
}

function Find-GameDir {
    $candidates = @(
        (Get-Location).Path,
        (Split-Path $PackageRoot -Parent),
        "D:\SteamLibrary\steamapps\common\MeijuStory_Demo",
        "C:\Program Files (x86)\Steam\steamapps\common\MeijuStory_Demo",
        "C:\Program Files\Steam\steamapps\common\MeijuStory_Demo"
    ) | Where-Object { $_ } | Select-Object -Unique

    foreach ($candidate in $candidates) {
        if (Test-GameDir $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }
    return Select-GameDir
}

function Assert-GameClosed {
    param([string]$GameDir)
    $root = (Resolve-Path $GameDir).Path.ToLowerInvariant()
    $running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.ToLowerInvariant().StartsWith($root) } catch { $false }
    }
    if ($running) {
        throw "Please close the game before uninstalling the mod."
    }
}

try {
    $gameDir = Find-GameDir
    if (!(Test-GameDir $gameDir)) {
        throw "Selected folder is not a valid game folder."
    }
    Assert-GameClosed $gameDir

    $resourcesDir = Join-Path $gameDir "resources"
    $backupDir = Join-Path $resourcesDir "yuki-vision-mod-backup"
    $hookBackup = Join-Path $backupDir "install-hooks.js.bak"
    $hookPath = Join-Path $resourcesDir "install-hooks.js"
    $payloadDir = Join-Path $resourcesDir "yuki-vision-mod"

    if (Test-Path $hookBackup) {
        Copy-Item -LiteralPath $hookBackup -Destination $hookPath -Force
    } else {
        throw "Missing install-hooks.js backup. Safe uninstall is not possible."
    }

    if (Test-Path $payloadDir) {
        Remove-Item -LiteralPath $payloadDir -Recurse -Force
    }

    Write-Host ""
    Write-Host "Uninstall complete. User config was kept for future installs." -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host ("Uninstall failed: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host ""
    exit 1
}
