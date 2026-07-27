# We source this file with -NoExit -File
$env:PATH = {{.WSHBINDIR_PWSH}} + "{{.PATHSEP}}" + $env:PATH

# Source dynamic script from wsh token
$waveterm_swaptoken_output = wsh token $env:WAVETERM_SWAPTOKEN pwsh 2>$null | Out-String
if ($waveterm_swaptoken_output -and $waveterm_swaptoken_output -ne "") {
    Invoke-Expression $waveterm_swaptoken_output
}
Remove-Variable -Name waveterm_swaptoken_output
Remove-Item Env:WAVETERM_SWAPTOKEN

# Load Wave completions
wsh completion powershell | Out-String | Invoke-Expression

if ($PSVersionTable.PSVersion.Major -lt 7) {
    return  # skip OSC setup entirely
}

if ($PSStyle.FileInfo.Directory -eq "`e[44;1m") {
    $PSStyle.FileInfo.Directory = "`e[34;1m"
}

$Global:_WAVETERM_SI_FIRSTPROMPT = $true
$Global:_WAVETERM_SI_BLOCK_SEEN = $false

# shell integration
function Global:_waveterm_si_blocked {
    # Check if we're in tmux or screen
    return ($env:TMUX -or $env:STY -or $env:TERM -like "tmux*" -or $env:TERM -like "screen*")
}

function Global:_waveterm_si_osc7 {
    if (_waveterm_si_blocked) { return }

    # Percent-encode the raw path as-is (handles UNC, drive letters, etc.)
    $encoded_pwd = [System.Uri]::EscapeDataString($PWD.Path)

    # OSC 7 - current directory
    Write-Host -NoNewline "`e]7;file://localhost/$encoded_pwd`a"
}

# Mirrors zsh_zshrc.sh's _waveterm_si_emit_env — see that file for the
# rationale and warp source pointers (context_chips/builtins.rs:127-187).
function Global:_waveterm_si_emit_env {
    if (_waveterm_si_blocked) { return }

    $parts = "cwd=$([System.Uri]::EscapeDataString($PWD.Path))"

    if (Get-Command git -ErrorAction SilentlyContinue) {
        $prevGitLocks = $env:GIT_OPTIONAL_LOCKS
        $env:GIT_OPTIONAL_LOCKS = "0"
        try {
            $gitBranch = & git symbolic-ref --short HEAD 2>$null
            if (-not $gitBranch) {
                $gitBranch = & git rev-parse --short HEAD 2>$null
            }
            if ($gitBranch) {
                $parts = "$parts;git_branch=$([System.Uri]::EscapeDataString($gitBranch.Trim()))"
                $diff = (& git -c diff.autoRefreshIndex=false diff --shortstat HEAD 2>$null) -join " "
                if ($diff) {
                    $parts = "$parts;git_diff_stats=$([System.Uri]::EscapeDataString($diff.Trim()))"
                }
            }
        } catch {}
        finally {
            $env:GIT_OPTIONAL_LOCKS = $prevGitLocks
        }
    }

    if ($env:VIRTUAL_ENV) {
        $venv = Split-Path -Leaf $env:VIRTUAL_ENV
        $parts = "$parts;venv=$([System.Uri]::EscapeDataString($venv))"
    }
    if ($env:CONDA_DEFAULT_ENV) {
        $parts = "$parts;conda=$([System.Uri]::EscapeDataString($env:CONDA_DEFAULT_ENV))"
    }
    if ($env:NODE_VERSION) {
        $parts = "$parts;node_version=$([System.Uri]::EscapeDataString($env:NODE_VERSION))"
    }

    Write-Host -NoNewline "`e]133;P;$parts`a"
}

function Global:_waveterm_si_prompt {
    param([int]$LastExitCode)
    if (_waveterm_si_blocked) { return }

    if ($Global:_WAVETERM_SI_FIRSTPROMPT) {
        $shellversion = $PSVersionTable.PSVersion.ToString()
        Write-Host -NoNewline "`e]16162;M;{`"shell`":`"pwsh`",`"shellversion`":`"$shellversion`",`"integration`":true}`a"
        $Global:_WAVETERM_SI_FIRSTPROMPT = $false
    } else {
        Write-Host -NoNewline "`e]16162;D;{`"exitcode`":$LastExitCode}`a"
        Write-Host -NoNewline "`e]133;D;$LastExitCode`a"
    }

    _waveterm_si_osc7
    _waveterm_si_emit_env
    Write-Host -NoNewline "`e]16162;A`a"
    Write-Host -NoNewline "`e]133;A`a"
}

if (Test-Path Function:prompt) {
    $global:_waveterm_original_prompt = $function:prompt
}

function Global:_waveterm_si_install_readline {
    if ($Global:_WAVETERM_SI_READLINE_DONE) { return }
    if (-not (Test-Path Function:PSConsoleHostReadLine)) { return }
    $Global:_WAVETERM_SI_READLINE_DONE = $true
    Copy-Item Function:PSConsoleHostReadLine Function:Global:_waveterm_original_readline -Force
    function Global:PSConsoleHostReadLine {
        try {
            $line = _waveterm_original_readline
        } catch {
            Copy-Item Function:_waveterm_original_readline Function:Global:PSConsoleHostReadLine -Force
            return ''
        }
        if ($line -is [string] -and $line.Trim().Length -gt 0) {
            $Global:_WAVETERM_SI_BLOCK_SEEN = $true
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
            $cmd64 = [Convert]::ToBase64String($bytes)
            $markerCmd = $line -replace '[\x00-\x1F\x7F]', ' '
            if ($markerCmd.Length -gt 256) { $markerCmd = $markerCmd.Substring(0, 256) }
            Write-Host -NoNewline "`e]16162;C;{`"cmd64`":`"$cmd64`"}`a"
            Write-Host -NoNewline "`e]133;C;$markerCmd`a"
        }
        $line
    }
}

function Global:prompt {
    _waveterm_si_install_readline
    $lastExitCode = $Global:LASTEXITCODE
    if ($null -eq $lastExitCode) { $lastExitCode = if ($?) { 0 } else { 1 } }

    if (_waveterm_si_blocked) {
        if ($global:_waveterm_original_prompt) {
            return & $global:_waveterm_original_prompt
        }
        return "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }

    _waveterm_si_prompt $lastExitCode
    $Global:LASTEXITCODE = $lastExitCode
    if ($env:WAVETERM_BLOCKS) {
        $gap = if ($Global:_WAVETERM_SI_BLOCK_SEEN) { "`n`n" } else { "`n" }
        return "$gap`e]133;B`a"
    }

    $original = if ($global:_waveterm_original_prompt) {
        & $global:_waveterm_original_prompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }
    "$original`e]133;B`a"
}
