# Support Diagnostics Bundle Triage

Use this when a user sends an `opencowork-support-bundle-YYYY-MM-DD.zip` file for issue analysis.

## What The Bundle Should Contain

The current support bundle is scoped to one session:

- `README.txt` - export timestamp, target session id, privacy defaults.
- `diagnostics-summary.json` - redacted runtime/config/session summary.
- `system-info.json` - app/runtime versions and included log file inventory.
- `logs/*.log` - redacted copies of recent app log files.

The bundle should not include message bodies, full tool inputs, full tool outputs, API keys, bearer tokens, URL credentials, raw DB files, or private attachments.

## First Checks

Run these from PowerShell, replacing `$zip` with the user-provided file path:

```powershell
$zip = "C:\path\to\opencowork-support-bundle-2026-06-06.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $archive.Entries | Select-Object FullName,Length,CompressedLength | Format-Table -AutoSize
} finally {
  $archive.Dispose()
}
```

Confirm:

- `diagnostics-summary.json` exists.
- `schemaVersion` is present.
- `targetSessionId` is set when the user generated the bundle from a session.
- `sessions.included` is `1`.
- `piRouteDiagnostics.Count` is `1`.

Quick summary command:

```powershell
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entry = $archive.GetEntry("diagnostics-summary.json")
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try {
    $obj = $reader.ReadToEnd() | ConvertFrom-Json
    $obj | Select-Object `
      schemaVersion,
      targetSessionId,
      @{n="sessionsTotal";e={$_.sessions.total}},
      @{n="sessionsIncluded";e={$_.sessions.included}},
      @{n="sessionIds";e={($_.sessions.items | ForEach-Object id) -join ","}},
      @{n="piRouteCount";e={$_.piRouteDiagnostics.Count}},
      @{n="recentErrorCount";e={$_.recentErrorSteps.Count}},
      @{n="recentAgentErrorCount";e={$_.recentAgentErrors.Count}} |
      Format-List
  } finally {
    $reader.Dispose()
  }
} finally {
  $archive.Dispose()
}
```

## Privacy Smoke Test

Before sharing snippets from a user bundle, scan for obvious leaks:

```powershell
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $allText = foreach ($entry in $archive.Entries) {
    if ($entry.FullName -match '\.(json|txt|log)$') {
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try { "`n---ENTRY:$($entry.FullName)---`n" + $reader.ReadToEnd() }
      finally { $reader.Dispose() }
    }
  }

  $patterns = @(
    'sk-[A-Za-z0-9_-]{12,}',
    'Bearer\s+[A-Za-z0-9._~+/=-]{12,}',
    'Authorization',
    'api[_-]?key\s*[:=]\s*[^,\s\}]+',
    'C:\\Users\\[^\\]+',
    'C:/Users/[^/]+'
  )

  foreach ($p in $patterns) {
    $matches = ($allText | Select-String -Pattern $p -AllMatches)
    [pscustomobject]@{ Pattern = $p; Count = $matches.Matches.Count }
  }
} finally {
  $archive.Dispose()
}
```

If a count is nonzero, inspect carefully before quoting or pasting bundle content.

## Main Triage Fields

Start with `diagnostics-summary.json`.

Session scope:

- `targetSessionId`
- `sessions.total`
- `sessions.included`
- `sessions.items[0].id`
- `sessions.items[0].title`

Session runtime config:

- `sessions.items[0].model`
- `sessions.items[0].configSetId`
- `sessions.items[0].thinkingLevel`
- `sessions.items[0].planMode`
- `sessions.items[0].cwd`

Agent/model route:

- `piRouteDiagnostics[0].requested.provider`
- `piRouteDiagnostics[0].requested.protocol`
- `piRouteDiagnostics[0].requested.model`
- `piRouteDiagnostics[0].resolved.provider`
- `piRouteDiagnostics[0].resolved.model`
- `piRouteDiagnostics[0].resolved.api`
- `piRouteDiagnostics[0].resolved.baseUrl`
- `piRouteDiagnostics[0].resolved.contextWindow`
- `piRouteDiagnostics[0].thinking.requestedLevel`
- `piRouteDiagnostics[0].thinking.effectiveLevel`
- `piRouteDiagnostics[0].thinking.mappedForCompatibility`
- `piRouteDiagnostics[0].thinking.supportsReasoningEffort`
- `piRouteDiagnostics[0].thinking.thinkingFormat`
- `piRouteDiagnostics[0].usedSyntheticModel`

Recent error metadata:

- `recentErrorSteps[].type`
- `recentErrorSteps[].status`
- `recentErrorSteps[].toolName`
- `recentErrorSteps[].durationMs`
- `recentErrorSteps[].contentLength`
- `recentErrorSteps[].toolOutputLength`
- `recentErrorSteps[].toolInputKeys`

Structured agent error summaries:

- `recentAgentErrors[].source`
- `recentAgentErrors[].stage`
- `recentAgentErrors[].httpStatus`
- `recentAgentErrors[].providerErrorCode`
- `recentAgentErrors[].providerErrorMessage`
- `recentAgentErrors[].piErrorMessage`
- `recentAgentErrors[].requestShape`
- `recentAgentErrors[].route`

## Common Interpretations

Configuration did not propagate:

- The session item has the wrong `configSetId`, `model`, or `thinkingLevel`.
- `piRouteDiagnostics[0].requested.*` does not match the UI selection the user reports.
- Compare with `config.activeConfigSetId` only as global context; the session fields are the source of truth for the failing session.

Duplicate model names across config sets:

- Same model name is not enough. Check `configSetId` and `requested.provider/protocol/baseUrl`.
- If `model` is the same but `configSetId` differs, use route diagnostics to confirm which endpoint was used.

Provider/protocol mismatch:

- `requested.protocol` differs from what the provider endpoint expects.
- `resolved.api` is unexpected, for example `openai-responses` vs `openai-completions`.
- Custom OpenAI-compatible endpoints should usually resolve to OpenAI-compatible APIs.

Thinking/reasoning incompatibility:

- `thinking.mappedForCompatibility` is true.
- `requestedLevel` differs from `effectiveLevel`.
- `supportsReasoningEffort` or `thinkingFormat` does not match the provider behavior.
- For 400-style upstream failures, also inspect redacted logs for provider error messages.

Upstream 400/401/429/5xx failures:

- Start from `recentAgentErrors`.
- Check `httpStatus`, `providerErrorCode`, and `providerErrorMessage`.
- Compare the embedded `route` with `piRouteDiagnostics[0]`.
- Use `requestShape` only to identify which parameter families were present; it should not contain request content.

Context/window issues:

- `resolved.contextWindow` or `resolved.maxTokens` is unexpectedly small or huge.
- If user configured a custom model window, check whether the resolved values reflect that configuration.

## Current Limitations

- Logs are redacted but still recent app logs, not perfectly filtered to the target session.
- `recentAgentErrors` is a redacted summary derived from existing trace/message errors. It may still miss provider-specific fields if the upstream SDK does not expose them in the error text.
- For hard `400 Param Incorrect` cases, the app may still need deeper SDK-side structured error capture to identify the exact rejected parameter.

## Recommended Next Improvement

Improve SDK-side structured error capture feeding `recentAgentErrors` with redacted:

- `sessionId`
- failure stage
- provider/model/api/baseUrl
- requested/effective thinking level
- HTTP status
- provider error code/message
- pi-agent error message
- request shape as field names/types only, not message content
