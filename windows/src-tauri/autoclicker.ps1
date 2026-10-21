Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class MouseClicker {
    [DllImport("user32.dll", CharSet = CharSet.Auto, CallingConvention = CallingConvention.StdCall)]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    private const int MOUSEEVENTF_LEFTDOWN = 0x02;
    private const int MOUSEEVENTF_LEFTUP = 0x04;

    public static void LeftClick() {
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }

    public static bool IsKeyPressed(int vKey) {
        return (GetAsyncKeyState(vKey) & 0x8000) != 0;
    }
}
"@

$stopFlag = Join-Path $PSScriptRoot "autoclicker_stop.flag"
if (Test-Path $stopFlag) { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue }

# F8 (119) veya ESC (27) ile de anında durdurulabilir
while ($true) {
    if (Test-Path $stopFlag) {
        Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue
        break
    }
    if ([MouseClicker]::IsKeyPressed(119) -or [MouseClicker]::IsKeyPressed(27)) {
        break
    }
    [MouseClicker]::LeftClick()
    Start-Sleep -Milliseconds 50
}
