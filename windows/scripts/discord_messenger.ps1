# Omi Discord Messenger Automation Engine
# Reliably activates Discord, navigates to the exact recipient/channel, and sends the message.

param(
    [string]$Target = "",
    [Parameter(Mandatory=$true)]
    [string]$Message = "",
    [switch]$IsGroup
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Window {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

    public static IntPtr FindDiscordMainWindow() {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return true;

            try {
                var p = System.Diagnostics.Process.GetProcessById((int)pid);
                if (p.ProcessName.Equals("Discord", StringComparison.OrdinalIgnoreCase)) {
                    StringBuilder sb = new StringBuilder(512);
                    GetWindowText(hWnd, sb, 512);
                    string title = sb.ToString();
                    if (!string.IsNullOrWhiteSpace(title) && !title.Equals("Discord Updater", StringComparison.OrdinalIgnoreCase)) {
                        found = hWnd;
                        return false;
                    }
                }
            } catch {}
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool ActivateWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;
        if (IsIconic(hWnd)) {
            ShowWindow(hWnd, 9); // SW_RESTORE
        } else {
            ShowWindow(hWnd, 5); // SW_SHOW
        }

        IntPtr fg = GetForegroundWindow();
        uint fgThread = 0;
        if (fg != IntPtr.Zero) {
            GetWindowThreadProcessId(fg, out fgThread);
        }
        uint curThread = GetCurrentThreadId();

        if (fgThread != 0 && fgThread != curThread) {
            AttachThreadInput(curThread, fgThread, true);
            SetForegroundWindow(hWnd);
            AttachThreadInput(curThread, fgThread, false);
        } else {
            SetForegroundWindow(hWnd);
        }

        // Win32 Alt-key trick to bypass Windows SetForegroundWindow restrictions
        keybd_event(0x12, 0, 0, 0); // Alt Down
        SetForegroundWindow(hWnd);
        keybd_event(0x12, 0, 2, 0); // Alt Up

        return true;
    }
}
"@

$wshell = New-Object -ComObject WScript.Shell

# 1. Locate Discord main window
$hwnd = [Win32Window]::FindDiscordMainWindow()

if ($hwnd -eq [IntPtr]::Zero) {
    # If not found, try starting Discord
    $discordPath = Join-Path $env:LOCALAPPDATA "Discord\Update.exe"
    if (Test-Path $discordPath) {
        Start-Process $discordPath -ArgumentList "--processStart Discord.exe"
        Start-Sleep -Milliseconds 1500
        $hwnd = [Win32Window]::FindDiscordMainWindow()
    }
}

if ($hwnd -ne [IntPtr]::Zero) {
    [Win32Window]::ActivateWindow($hwnd)
    Start-Sleep -Milliseconds 200
} else {
    # Fallback to AppActivate
    $wshell.AppActivate("Discord")
    Start-Sleep -Milliseconds 200
}

# 2. If target is specified, use Discord's Quick Switcher
$trimmedTarget = if ($Target) { $Target.Trim() } else { "" }
if ($trimmedTarget.Length -gt 0) {
    # Detect if target is a group or channel (e.g. "not defteri grubuna", "genel kanalı")
    $isGroupDetected = $IsGroup -or ($trimmedTarget.StartsWith("#")) -or ($trimmedTarget -match '(?i)\b(grup|group|kanal|channel|oda|sunucu|server)\b')
    
    # Strip group/channel suffixes so Discord gets the clean name
    $cleanTargetName = $trimmedTarget -replace '(?i)\s*(?:grubuna|grubun|grubu|grub|grup|group|kanalına|kanalı|kanal|channel|odasına|odası|sunucusuna|sunucusu|sunucu|server)\b', ''
    $cleanTargetName = $cleanTargetName.Trim()
    if ($cleanTargetName.Length -eq 0) { $cleanTargetName = $trimmedTarget }

    # Groups/channels must NOT have '@' prefix, otherwise Discord only searches users/DMs
    $searchQuery = if ($isGroupDetected) {
        $cleanTargetName
    } elseif ($trimmedTarget.StartsWith("@") -or $trimmedTarget.StartsWith("#")) {
        $trimmedTarget
    } else {
        "@" + $cleanTargetName
    }
    # Open Quick Switcher (Ctrl+K)
    [System.Windows.Forms.SendKeys]::SendWait("^k")
    Start-Sleep -Milliseconds 220

    # Clear any previous search in the box
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 40
    [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
    Start-Sleep -Milliseconds 40

    # Type exact search query
    [System.Windows.Forms.SendKeys]::SendWait($searchQuery)
    # Give Discord time to query local cache & network and filter the results
    Start-Sleep -Milliseconds 350

    # Select top search match
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    # Wait for Discord channel/DM view to load and chat input box to focus
    Start-Sleep -Milliseconds 300
}

# 3. Paste message into focused chat box and send
if ($Message -and $Message.Trim().Length -gt 0) {
    # Ensure clipboard contains the message
    Set-Clipboard -Value $Message
    Start-Sleep -Milliseconds 50

    # Paste text
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 60

    # Send message
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
}

$result = @{
    success = $true
    app = "Discord"
    target = $trimmedTarget
    message = $Message
} | ConvertTo-Json -Compress

Write-Output $result
