Add-Type -AssemblyName System.Windows.Forms

Clear-Host
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "      Instagram Otomatik Kaydırıcı (Omi)       " -ForegroundColor Yellow
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "5 saniye içinde Instagram penceresine tıklayın..." -ForegroundColor Green

for ($i = 5; $i -gt 0; $i--) {
    Write-Host "$i..." -ForegroundColor Yellow
    Start-Sleep -Seconds 1
}

Write-Host "`nKaydırma başladı! Her 3 saniyede bir aşağı kaydırılıyor." -ForegroundColor Green
Write-Host "Durdurmak için bu pencereyi kapatabilir veya Ctrl + C yapabilirsiniz.`n" -ForegroundColor Magenta

while ($true) {
    [System.Windows.Forms.SendKeys]::SendWait("{DOWN}")
    Start-Sleep -Seconds 3
}
