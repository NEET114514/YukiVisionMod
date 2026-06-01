$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PackageRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PayloadDir = Join-Path $PackageRoot "payload"

function Test-GameDir {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
    $hook = Join-Path $Dir "resources\install-hooks.js"
    $asar = Join-Path $Dir "resources\app.asar"
    $exe = Get-ChildItem -LiteralPath $Dir -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    return ($null -ne $exe) -and (Test-Path $hook) -and (Test-Path $asar)
}

function Select-GameDir {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select the game folder that contains the exe file."
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        return $dialog.SelectedPath
    }
    throw "No game folder selected. Install canceled."
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
        throw "Please close the game before installing the mod."
    }
}

function Backup-FileOnce {
    param([string]$Source, [string]$Target)
    if ((Test-Path $Source) -and !(Test-Path $Target)) {
        Copy-Item -LiteralPath $Source -Destination $Target -Force
    }
}

function Patch-InstallHooks {
    param([string]$HookPath)

    $content = Get-Content -LiteralPath $HookPath -Raw -Encoding UTF8

    $needle = "const Module = require('module');"
    $block = @'

// YUKI_VISION_MOD_BLOCK_START
function yukiVisionModFileUrl(fileName) {
  try {
    return require('url').pathToFileURL(path.join(__dirname, 'yuki-vision-mod', fileName)).href;
  } catch (_) {
    return '';
  }
}

function applyYukiVisionModToBuffer(relPath, buffer) {
  try {
    const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^app\.asar\//, '');
    if (normalized !== 'index.html' && normalized !== 'desktop-pet.html' && normalized !== 'pet-chat-bubble.html') {
      return buffer;
    }

    let text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : Buffer.from(buffer).toString('utf8');
    if (text.includes('YUKI_VISION_MOD_INJECTED')) {
      return Buffer.from(text, 'utf8');
    }

    const commonUrl = yukiVisionModFileUrl('mod-common.js');
    const mainUrl = yukiVisionModFileUrl('renderer-main.js');
    const petUrl = yukiVisionModFileUrl('renderer-pet.js');
    if (!commonUrl) {
      return buffer;
    }

    if (normalized === 'index.html') {
      const injection = [
        '<!-- YUKI_VISION_MOD_INJECTED -->',
        '<script src="' + commonUrl + '"></script>',
        '<script src="' + mainUrl + '"></script>'
      ].join('\n');
      text = text.replace(/<\/body>/i, injection + '\n</body>');
      return Buffer.from(text, 'utf8');
    }

    if (normalized === 'desktop-pet.html') {
      const needle = "await loadScript('src/js/systems/DesktopPetVoiceManager.js');";
      const injected = [
        needle,
        "                // YUKI_VISION_MOD_INJECTED",
        "                await loadScript('" + commonUrl + "');",
        "                await loadScript('" + petUrl + "');",
        "                console.log('Yuki Vision Mod runtime loaded');"
      ].join('\n');
      if (text.includes(needle)) {
        text = text.replace(needle, injected);
      } else {
        const fallback = [
          '<!-- YUKI_VISION_MOD_INJECTED -->',
          '<script src="' + commonUrl + '"></script>',
          '<script src="' + petUrl + '"></script>'
        ].join('\n');
        text = text.replace(/<\/body>/i, fallback + '\n</body>');
      }
      return Buffer.from(text, 'utf8');
    }

    if (normalized === 'pet-chat-bubble.html') {
      const bubbleStyle = [
        '<!-- YUKI_VISION_MOD_INJECTED -->',
        '<style id="yuki-vision-mod-bubble-style">',
        'body{max-width:700px!important;padding:12px!important;}',
        '.chat-bubble{max-width:660px!important;min-width:320px!important;text-align:left!important;font-size:14px!important;line-height:1.58!important;padding:16px 20px!important;}',
        '.message-text{white-space:pre-wrap!important;}',
        '</style>'
      ].join('\n');
      const bubbleScript = [
        '<script>',
        '(function(){',
        '  if(window.__YukiVisionModBubbleFit){return;}',
        '  window.__YukiVisionModBubbleFit=true;',
        '  function fit(){',
        '    try{',
        '      var bubble=document.querySelector(".chat-bubble");',
        '      if(!bubble||!window.electronAPI||typeof window.electronAPI.resizeChatBubble!=="function"){return;}',
        '      var rect=bubble.getBoundingClientRect();',
        '      var width=Math.min(700,Math.max(380,Math.ceil(rect.width)+28));',
        '      var height=Math.min(440,Math.max(120,Math.ceil(document.documentElement.scrollHeight)+24,Math.ceil(bubble.scrollHeight)+54));',
        '      window.electronAPI.resizeChatBubble(width,height).catch(function(){});',
        '    }catch(_){ }',
        '  }',
        '  function schedule(){[0,80,250,600].forEach(function(delay){setTimeout(fit,delay);});}',
        '  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",schedule);}else{schedule();}',
        '  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,characterData:true});',
        '})();',
        '</script>'
      ].join('\n');
      text = text.replace(/<\/head>/i, bubbleStyle + '\n</head>');
      text = text.replace(/<\/body>/i, bubbleScript + '\n</body>');
      return Buffer.from(text, 'utf8');
    }
  } catch (error) {
    console.warn('[YukiVisionMod] injection failed:', error && error.message ? error.message : error);
  }
  return buffer;
}

function installYukiVisionRealtimeMainHook() {
  try {
    require(path.join(__dirname, 'yuki-vision-mod', 'realtime-main.js'));
    console.log('[YukiVisionMod] Realtime main hook loaded');
  } catch (error) {
    console.warn('[YukiVisionMod] Realtime main hook failed:', error && error.message ? error.message : error);
  }
  try {
    require(path.join(__dirname, 'yuki-vision-mod', 'doubao-rtc-main.js'));
    console.log('[YukiVisionMod] Doubao RTC main hook loaded');
  } catch (error) {
    console.warn('[YukiVisionMod] Doubao RTC main hook failed:', error && error.message ? error.message : error);
  }
}
// YUKI_VISION_MOD_BLOCK_END
'@
    if ($content -match "(?s)// YUKI_VISION_MOD_BLOCK_START.*?// YUKI_VISION_MOD_BLOCK_END") {
        $content = [regex]::Replace($content, "(?s)// YUKI_VISION_MOD_BLOCK_START.*?// YUKI_VISION_MOD_BLOCK_END", $block.Trim())
    } else {
        if (-not $content.Contains($needle)) {
            throw "Could not find the module import position in install-hooks.js."
        }
        $content = $content.Replace($needle, "$needle`r`n$block")
    }

    $oldBufferLine = "      return Buffer.from(cryptoModule.getDecryptedFile(candidate));"
    $newBufferLine = @'
      const rawBuffer = Buffer.from(cryptoModule.getDecryptedFile(candidate));
      return applyYukiVisionModToBuffer(candidate, rawBuffer);
'@
    if ($content.Contains($oldBufferLine)) {
        $content = $content.Replace($oldBufferLine, $newBufferLine)
    }

    $oldTextLine = "      return cryptoModule.getDecryptedText(candidate);"
    $newTextLine = @'
      const rawBuffer = Buffer.from(cryptoModule.getDecryptedFile(candidate));
      return applyYukiVisionModToBuffer(candidate, rawBuffer).toString('utf8');
'@
    if ($content.Contains($oldTextLine)) {
        $content = $content.Replace($oldTextLine, $newTextLine)
    }

    $oldServeLine = "    const contentType = getContentTypeByPath(rel);"
    $newServeLine = @'
    content = applyYukiVisionModToBuffer(rel, content);
    const contentType = getContentTypeByPath(rel);
'@
    if ($content.Contains($oldServeLine) -and $content -notmatch "content = applyYukiVisionModToBuffer\(rel, content\);") {
        $content = $content.Replace($oldServeLine, $newServeLine)
    }

    $oldRunMainLine = "  runMainFromMemory(cryptoModule, appDir, mainRelativePath || 'main.js');"
    $newRunMainLine = @'
  runMainFromMemory(cryptoModule, appDir, mainRelativePath || 'main.js');
  if (typeof installYukiVisionRealtimeMainHook === 'function') {
    installYukiVisionRealtimeMainHook();
  }
'@
    if ($content.Contains($oldRunMainLine) -and $content -notmatch "installYukiVisionRealtimeMainHook\(\);") {
        $content = $content.Replace($oldRunMainLine, $newRunMainLine)
    }

    if ($content -notmatch "applyYukiVisionModToBuffer\(candidate, rawBuffer\)" -or
        $content -notmatch "applyYukiVisionModToBuffer\(candidate, rawBuffer\)\.toString\('utf8'\)" -or
        $content -notmatch "content = applyYukiVisionModToBuffer\(rel, content\);") {
        throw "install-hooks.js patch was not fully written."
    }

    Set-Content -LiteralPath $HookPath -Value $content -Encoding UTF8
}

try {
    if (!(Test-Path $PayloadDir)) {
        throw "Missing payload directory. The package is incomplete."
    }

    $gameDir = Find-GameDir
    if (!(Test-GameDir $gameDir)) {
        throw "Selected folder is not a valid game folder."
    }
    Assert-GameClosed $gameDir

    $resourcesDir = Join-Path $gameDir "resources"
    $backupDir = Join-Path $resourcesDir "yuki-vision-mod-backup"
    $targetPayload = Join-Path $resourcesDir "yuki-vision-mod"
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    New-Item -ItemType Directory -Force -Path $targetPayload | Out-Null

    Backup-FileOnce (Join-Path $resourcesDir "install-hooks.js") (Join-Path $backupDir "install-hooks.js.bak")
    Backup-FileOnce (Join-Path $resourcesDir "app.asar") (Join-Path $backupDir "app.asar.bak")
    Backup-FileOnce (Join-Path $gameDir ".integrity") (Join-Path $backupDir "integrity.bak")

    Copy-Item -Path (Join-Path $PayloadDir "*") -Destination $targetPayload -Recurse -Force
    Patch-InstallHooks (Join-Path $resourcesDir "install-hooks.js")

    Write-Host ""
    Write-Host "Install complete. Open the game and use the new Desktop Pet Settings button." -ForegroundColor Green
    Write-Host "Run uninstall.bat if you need to remove the mod."
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host ("Install failed: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host ""
    exit 1
}
