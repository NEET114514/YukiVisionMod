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

    $findOverrideFunc = @'
function findOverridePath(appDir, relPath) {
  const overrideRoot = path.join(appDir, 'overrides');
  const candidates = lookupCandidatesFromRelative(relPath);
  for (const candidate of candidates) {
    const overridePath = path.join(overrideRoot, ...candidate.split('/'));
    if (fs.existsSync(overridePath)) {
      return overridePath;
    }
  }
  return null;
}
'@
    if ($content -notmatch "function findOverridePath") {
        $content = $content -replace '(return Array\.from\(new Set\(out\)\);\s*\})', "`$1`r`n`r`n$findOverrideFunc"
    }

    $newInstallFsAndModuleHooks = @'
function installFsAndModuleHooks(cryptoModule, appDir) {
  const originalReadFileSync = fs.readFileSync;
  const originalResolveFilename = Module._resolveFilename;
  const originalJsLoader = Module._extensions['.js'];
  const originalJsonLoader = Module._extensions['.json'];

  function resolveVirtualModuleFilename(request, parent) {
    if (typeof request !== 'string' || !request) {
      return null;
    }

    const isRelative = request.startsWith('./') || request.startsWith('../');
    const isAbsolute = path.isAbsolute(request);
    if (!isRelative && !isAbsolute) {
      return null;
    }

    const baseDir = isAbsolute
      ? appDir
      : path.dirname((parent && parent.filename) ? parent.filename : path.join(appDir, 'main.js'));

    const requestedAbs = isAbsolute
      ? path.normalize(request)
      : path.normalize(path.resolve(baseDir, request));

    const candidates = [];
    if (path.extname(requestedAbs)) {
      candidates.push(requestedAbs);
    } else {
      candidates.push(requestedAbs);
      candidates.push(`${requestedAbs}.js`);
      candidates.push(`${requestedAbs}.json`);
      candidates.push(path.join(requestedAbs, 'index.js'));
      candidates.push(path.join(requestedAbs, 'index.json'));
    }

    for (const candidate of candidates) {
      const rel = toRelativePosix(appDir, candidate);
      if (rel.startsWith('..')) {
        continue;
      }
      if (findOverridePath(appDir, rel)) {
        return candidate;
      }
      if (hasMappedDecryptedFile(cryptoModule, rel)) {
        return candidate;
      }
    }

    return null;
  }

  fs.readFileSync = function patchedReadFileSync(filePath, options) {
    const abs = resolveFilePath(filePath);
    if (!abs) {
      return originalReadFileSync.apply(this, arguments);
    }

    const rel = toRelativePosix(appDir, abs);
    if (rel.startsWith('..')) {
      return originalReadFileSync.apply(this, arguments);
    }

    const overridePath = findOverridePath(appDir, rel);
    if (overridePath) {
      const data = originalReadFileSync.call(fs, overridePath);
      console.warn('[OverrideHit:FS]', rel, '=>', overridePath);
      return encodeByOption(data, normalizeEncoding(options));
    }

    if (hasMappedDecryptedFile(cryptoModule, rel)) {
      const data = getMappedDecryptedBuffer(cryptoModule, rel);
      return encodeByOption(data, normalizeEncoding(options));
    }

    return originalReadFileSync.apply(this, arguments);
  };

  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    const virtual = resolveVirtualModuleFilename(request, parent);
    if (virtual) {
      return virtual;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  Module._extensions['.js'] = function patchedJsLoader(mod, filename) {
    const rel = toRelativePosix(appDir, filename);
    if (!rel.startsWith('..')) {
      const overridePath = findOverridePath(appDir, rel);
      if (overridePath) {
        const source = originalReadFileSync.call(fs, overridePath, 'utf8');
        console.warn('[OverrideHit:JS]', rel, '=>', overridePath);
        mod._compile(source, filename);
        return;
      }
    }
    if (!rel.startsWith('..') && hasMappedDecryptedFile(cryptoModule, rel)) {
      const source = getMappedDecryptedText(cryptoModule, rel);
      mod._compile(source, filename);
      return;
    }
    originalJsLoader(mod, filename);
  };

  Module._extensions['.json'] = function patchedJsonLoader(mod, filename) {
    const rel = toRelativePosix(appDir, filename);
    if (!rel.startsWith('..')) {
      const overridePath = findOverridePath(appDir, rel);
      if (overridePath) {
        const source = originalReadFileSync.call(fs, overridePath, 'utf8');
        console.warn('[OverrideHit:JSON]', rel, '=>', overridePath);
        mod.exports = JSON.parse(source);
        return;
      }
    }
    if (!rel.startsWith('..') && hasMappedDecryptedFile(cryptoModule, rel)) {
      const source = getMappedDecryptedText(cryptoModule, rel);
      mod.exports = JSON.parse(source);
      return;
    }
    originalJsonLoader(mod, filename);
  };
}
'@
    $oldInstallFsAndModuleHooksPattern = '(?s)(function installFsAndModuleHooks\(cryptoModule, appDir\) \{.*?\n\})'
    if ($content -match $oldInstallFsAndModuleHooksPattern) {
        $content = $content -replace $oldInstallFsAndModuleHooksPattern, $newInstallFsAndModuleHooks
    }

    $newInstallProtocolHook = @'
function installProtocolHook(cryptoModule, appDir) {
  const { app, session } = require('electron');

  const installedSessions = new WeakSet();

  function serveFileResponse(filePath, rel, request) {
    let content;
    try {
      content = fs.readFileSync(filePath);
    } catch (_) {
      return new Response('Not Found', { status: 404 });
    }

    content = applyYukiVisionModToBuffer(rel, content);
    const contentType = getContentTypeByPath(rel);
    const totalSize = content.length;
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const clampedEnd = Math.min(end, totalSize - 1);
        const chunk = content.slice(start, clampedEnd + 1);
        return new Response(chunk, {
          status: 206,
          headers: {
            'content-type': contentType,
            'content-range': `bytes ${start}-${clampedEnd}/${totalSize}`,
            'accept-ranges': 'bytes',
            'content-length': String(chunk.length),
          },
        });
      }
    }

    return new Response(content, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(totalSize),
        'accept-ranges': 'bytes',
      },
    });
  }

  async function registerOnSession(targetSession) {
    if (!targetSession || installedSessions.has(targetSession)) {
      return;
    }

    const protocolApi = targetSession.protocol;
    if (await protocolApi.isProtocolHandled('file')) {
      await protocolApi.unhandle('file');
    }

    await protocolApi.handle('file', async (request) => {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) {
        pathname = pathname.slice(1);
      }

      const filePath = path.normalize(pathname);
      const rel = toRelativePosix(appDir, filePath);

      if (!rel.startsWith('..')) {
        const overridePath = findOverridePath(appDir, rel);
        if (overridePath) {
          const body = fs.readFileSync(overridePath);
          console.warn('[OverrideHit:PROTO]', rel, '=>', overridePath);
          return new Response(body, {
            headers: {
              'content-type': getContentTypeByPath(rel),
              'content-length': String(body.length),
              'cache-control': 'no-store',
            },
          });
        }
      }

      if (!rel.startsWith('..') && hasMappedDecryptedFile(cryptoModule, rel)) {
        const body = getMappedDecryptedBuffer(cryptoModule, rel);
        return new Response(body, {
          headers: {
            'content-type': getContentTypeByPath(rel),
            'content-length': String(body.length),
            'cache-control': 'no-store',
          },
        });
      }

      return serveFileResponse(filePath, rel, request);
    });

    installedSessions.add(targetSession);
  }

  async function registerFileInterceptor() {
    await registerOnSession(session.defaultSession);
    await registerOnSession(session.fromPartition('persist:launcher'));
    await registerOnSession(session.fromPartition('persist:main'));
  }

  const onError = (error) => {
    console.error('[Encryption] file protocol hook registration failed:', error && error.message ? error.message : error);
  };

  if (app.isReady()) {
    registerFileInterceptor().catch(onError);
    return;
  }

  app.whenReady().then(() => registerFileInterceptor().catch(onError));
}
'@
    $oldInstallProtocolHookPattern = '(?s)(function installProtocolHook\(cryptoModule, appDir\) \{.*?\n\})'
    if ($content -match $oldInstallProtocolHookPattern) {
        $content = $content -replace $oldInstallProtocolHookPattern, $newInstallProtocolHook
    }

    $newRunMainFromMemory = @'
function runMainFromMemory(cryptoModule, appDir, mainRelativePath) {
  const mainRel = (mainRelativePath || 'main.js').split('\\').join('/');
  const overridePath = findOverridePath(appDir, mainRel);
  const source = overridePath
    ? fs.readFileSync(overridePath, 'utf8')
    : getMappedDecryptedText(cryptoModule, mainRel);
  if (overridePath) {
    console.warn('[OverrideHit:MAIN]', mainRel, '=>', overridePath);
  }

  const virtualAsarRoot = path.join(appDir, 'app.asar');
  const mainAbs = path.join(virtualAsarRoot, ...mainRel.split('/'));
  const mainModule = new Module(mainAbs, null);
  mainModule.filename = mainAbs;
  mainModule.paths = Module._nodeModulePaths(path.dirname(mainAbs));
  process.mainModule = mainModule;
  require.main = mainModule;
  mainModule._compile(source, mainAbs);
}
'@
    $oldRunMainFromMemoryPattern = '(?s)(function runMainFromMemory\(cryptoModule, appDir, mainRelativePath\) \{.*?\n\})'
    if ($content -match $oldRunMainFromMemoryPattern) {
        $content = $content -replace $oldRunMainFromMemoryPattern, $newRunMainFromMemory
    }

    $newBootstrapAll = @'
function bootstrapAll(cryptoModule, appDir, mainRelativePath, payloadRoot) {
  if (!cryptoModule || typeof cryptoModule.bootstrap !== 'function') {
    throw new Error('invalid crypto module');
  }
  if (!appDir || typeof appDir !== 'string') {
    throw new Error('invalid appDir');
  }

  cryptoModule.bootstrap(payloadRoot || appDir);
  installFsAndModuleHooks(cryptoModule, appDir);
  installProtocolHook(cryptoModule, appDir);
  runMainFromMemory(cryptoModule, appDir, mainRelativePath || 'main.js');
  if (typeof installYukiVisionRealtimeMainHook === 'function') {
    installYukiVisionRealtimeMainHook();
  }
}
'@
    $oldBootstrapAllPattern = '(?s)(function bootstrapAll\(cryptoModule, appDir, mainRelativePath, payloadRoot\) \{.*?\n\})'
    if ($content -match $oldBootstrapAllPattern) {
        $content = $content -replace $oldBootstrapAllPattern, $newBootstrapAll
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