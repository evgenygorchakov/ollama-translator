# Автозапуск Silero-сервера при входе в Windows: задача Планировщика «Silero TTS» запускает
# silero-serve.cmd без окна (conhost --headless). Права администратора не нужны.
#   .\install-autostart.ps1           создать (пересоздать) задачу и перезапустить сервер
#   .\install-autostart.ps1 -Remove   удалить задачу и остановить сервер
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$TaskName = "Silero TTS"
$Venv = Join-Path $PSScriptRoot ".venv"

# Сервер из этой папки. Лаунчер venv держит настоящий python.exe дочерним процессом и уносит
# его с собой. Второй экземпляр ошибкой не упадёт: на Windows Flask садится на занятый порт.
function Stop-Server {
    Get-Process python, pythonw -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "$Venv\*" } |
        Stop-Process -Force
}

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-Server
    Write-Host "Задача «$TaskName» удалена, сервер остановлен."
    return
}

if (-not (Test-Path (Join-Path $Venv "Scripts\python.exe"))) {
    throw "Нет $Venv — сначала установите сервер (README.md)."
}

# conhost --headless не передаёт cmd рабочий каталог, поэтому путь к скрипту полный.
$serve = Join-Path $PSScriptRoot "silero-serve.cmd"
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless cmd.exe /c `"$serve`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Без лимита времени (по умолчанию задачу снимают через 3 дня), с обычным приоритетом
# (по умолчанию пониженный) и на батарее тоже.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 5 `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Silero TTS для Ollama Translator: $serve" -Force | Out-Null

Stop-Server
# Задача числится запущенной, пока не закроются её cmd и conhost, а запуск до этого
# Планировщик молча пропустит (IgnoreNew). Ждём, пока прежний экземпляр завершится.
$deadline = (Get-Date).AddSeconds(10)
while ((Get-ScheduledTask -TaskName $TaskName).State -eq "Running") {
    if ((Get-Date) -gt $deadline) { throw "Прежний экземпляр задачи «$TaskName» не завершился." }
    Start-Sleep -Milliseconds 200
}
Start-ScheduledTask -TaskName $TaskName
Write-Host "Задача «$TaskName» создана, сервер запускается (около 10 с)."
Write-Host "Проверка: curl.exe -s http://127.0.0.1:5011/health   Лог: $PSScriptRoot\silero.log"
