param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [switch]$CheckRateLimit
)

$ErrorActionPreference = 'Stop'
$secureKey = Read-Host 'PRIVATE_LLM_API_KEY (ключ с Mac)' -AsSecureString
$credential = New-Object System.Net.NetworkCredential('', $secureKey)
$headers = @{ Authorization = "Bearer $($credential.Password)" }
$baseUrl = $ServerUrl.TrimEnd('/')

function Invoke-Chat($Messages) {
  $body = @{ messages = @($Messages); stream = $false } | ConvertTo-Json -Depth 6 -Compress
  Invoke-RestMethod -Uri "$baseUrl/api/local-llm/chat" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec $requestTimeoutSec
}

$status = Invoke-RestMethod -Uri "$baseUrl/api/local-llm/status" -Headers $headers
if (-not $status.ready) { throw $status.error }
$requestTimeoutSec = [int][Math]::Ceiling(($status.limits.queueTimeoutMs + $status.limits.timeoutMs) / 1000) + 15
Write-Host "OK: модель $($status.model), контекст $($status.context), ответ $($status.maxTokens)"
$results = @()
$history = @()
foreach ($prompt in @('Сколько будет 17 + 25? Ответь только числом.', 'Прибавь 8 к предыдущему результату. Ответь только числом.', 'Назови столицу Франции. Ответь одним словом.')) {
  $history += @{ role = 'user'; content = $prompt }
  $started = Get-Date
  $answer = Invoke-Chat $history
  if (-not $answer.done -or [string]::IsNullOrWhiteSpace($answer.message.content)) { throw 'Ответ не завершён.' }
  $results += @{ prompt = $prompt; answer = $answer.message.content; elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds }
  $history += @{ role = 'assistant'; content = $answer.message.content }
  Write-Host "OK: $($answer.message.content)"
}

$contextRejected = $false
try { Invoke-Chat @(@{ role = 'user'; content = ('x' * $status.context) }) | Out-Null }
catch {
  if ([int]$_.Exception.Response.StatusCode -ne 400) { throw }
  $contextRejected = $true
  Write-Host 'OK: слишком большой вопрос отклонён с HTTP 400'
}
if (-not $contextRejected) { throw 'Ограничение контекста не сработало.' }

$rateChecked = $false
if ($CheckRateLimit) {
  for ($i = 0; $i -le $status.limits.requestsPerMinute; $i++) {
    try { Invoke-Chat @() | Out-Null }
    catch {
      $code = [int]$_.Exception.Response.StatusCode
      if ($code -eq 429) { $rateChecked = $true; break }
      if ($code -ne 400) { throw }
    }
  }
  if (-not $rateChecked) { throw 'Rate limit не сработал.' }
  Write-Host 'OK: rate limit HTTP 429. Подождите минуту перед следующим запросом.'
}

$report = @{ checkedAt = (Get-Date).ToUniversalTime().ToString('o'); target = $baseUrl; clientLocation = 'Windows-second-computer'; service = $status; sequentialChat = $results; maxContextPassed = $contextRejected; rateLimitChecked = $rateChecked }
$report | ConvertTo-Json -Depth 8 | Set-Content -Path './day-30-windows-results.json' -Encoding UTF8
Write-Host 'Отчёт сохранён: day-30-windows-results.json'
