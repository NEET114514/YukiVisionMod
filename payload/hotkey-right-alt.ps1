$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class YukiVisionKeyState {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@

$vkRightAlt = 0xA5
$wasDown = $false

while ($true) {
    $state = [YukiVisionKeyState]::GetAsyncKeyState($vkRightAlt)
    $isDown = (($state -band 0x8000) -ne 0)
    if ($isDown -ne $wasDown) {
        if ($isDown) {
            [Console]::Out.WriteLine("down")
        } else {
            [Console]::Out.WriteLine("up")
        }
        [Console]::Out.Flush()
        $wasDown = $isDown
    }
    Start-Sleep -Milliseconds 25
}
