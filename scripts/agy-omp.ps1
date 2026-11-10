$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& bun run (Join-Path $ScriptDir "antigravity-stealth-launcher.ts") @args
