import { GeneratedScript, UninstallScriptInput } from './types';

export function generateWindowsScript(input: UninstallScriptInput): GeneratedScript {
  const { removeUserData, logPath } = input;

  const purgeBlock = removeUserData
    ? `
Log "Removing user data..."
Remove-Item -Recurse -Force "$env:APPDATA\\ParentSync" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\ParentSync" -ErrorAction SilentlyContinue
`
    : `
Log "Skipping user data removal (kept by user choice)."
`;

  const content = `# ParentSync uninstall script — Windows — generated at runtime. Idempotent.

$LogPath = "${logPath.replace(/\\/g, '\\\\')}"

function Log($msg) {
  $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Add-Content -Path $LogPath -Value "[$ts] $msg"
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null
"" | Out-File -Encoding utf8 $LogPath
Log "ParentSync uninstall starting (removeUserData=${removeUserData})"

Start-Sleep -Seconds 2
Log "Stopping any running ParentSync process..."
Get-Process -Name "ParentSync" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# NSIS installer creates "Uninstall ParentSync.exe" — run it silently.
$Uninstaller = "$env:LOCALAPPDATA\\Programs\\ParentSync\\Uninstall ParentSync.exe"
if (Test-Path $Uninstaller) {
  Log "Running NSIS uninstaller silently..."
  Start-Process -FilePath $Uninstaller -ArgumentList "/S" -Wait
} else {
  Log "NSIS uninstaller not found at $Uninstaller — skipping."
}

# Run-on-login registry key (added by NSIS but belt-and-braces).
Log "Removing Run-on-login registry key..."
Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" \`
  -Name "ParentSync" -ErrorAction SilentlyContinue
${purgeBlock}
Log "ParentSync uninstall complete."
exit 0
`;

  return {
    filename: 'parentsync-uninstall.ps1',
    content,
    interpreter: 'powershell',
  };
}
