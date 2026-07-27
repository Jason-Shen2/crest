# this file is sourced with -C
# Add Wave binary directory to PATH
set -x PATH {{.WSHBINDIR}} $PATH

# Source dynamic script from wsh token (the echo is to prevent fish from complaining about empty input)
wsh token "$WAVETERM_SWAPTOKEN" fish 2>/dev/null | source
set -e WAVETERM_SWAPTOKEN

# Load Wave completions
wsh completion fish | source

set -g _WAVETERM_SI_FIRSTPROMPT 1
set -g _WAVETERM_SI_BLOCK_SEEN 0

# shell integration
function _waveterm_si_blocked
    # Check if we're in tmux or screen (using fish-native checks)
    set -q TMUX; or set -q STY; or string match -q 'tmux*' -- $TERM; or string match -q 'screen*' -- $TERM
end

function _waveterm_si_osc7
    _waveterm_si_blocked; and return
    # Use fish-native URL encoding
    set -l encoded_pwd (string escape --style=url -- "$PWD")
    printf '\033]7;file://localhost%s\007' $encoded_pwd
end

# Mirrors zsh_zshrc.sh's _waveterm_si_emit_env — see that file for the
# rationale and warp source pointers (context_chips/builtins.rs:127-187).
function _waveterm_si_emit_env
    _waveterm_si_blocked; and return
    set -l parts "cwd="(string escape --style=url -- "$PWD")

    if type -q git
        set -l _git_branch (env GIT_OPTIONAL_LOCKS=0 git symbolic-ref --short HEAD 2>/dev/null)
        if test -z "$_git_branch"
            set _git_branch (env GIT_OPTIONAL_LOCKS=0 git rev-parse --short HEAD 2>/dev/null)
        end
        if test -n "$_git_branch"
            set parts "$parts;git_branch="(string escape --style=url -- "$_git_branch")
            set -l _diff (env GIT_OPTIONAL_LOCKS=0 git -c diff.autoRefreshIndex=false diff --shortstat HEAD 2>/dev/null)
            if test -n "$_diff"
                set parts "$parts;git_diff_stats="(string escape --style=url -- "$_diff")
            end
        end
    end

    if test -n "$VIRTUAL_ENV"
        set parts "$parts;venv="(string escape --style=url -- (basename "$VIRTUAL_ENV"))
    end
    if test -n "$CONDA_DEFAULT_ENV"
        set parts "$parts;conda="(string escape --style=url -- "$CONDA_DEFAULT_ENV")
    end
    if test -n "$NODE_VERSION"
        set parts "$parts;node_version="(string escape --style=url -- "$NODE_VERSION")
    end

    printf '\033]133;P;%s\007' "$parts"
end

function _waveterm_si_restore_status
    return $argv[1]
end

if functions -q fish_prompt
    functions -c fish_prompt _waveterm_si_user_prompt
end
if test -n "$WAVETERM_BLOCKS"
    function fish_right_prompt
    end
    function fish_greeting
    end
end

function fish_prompt
    set -l _waveterm_si_status $status
    if _waveterm_si_blocked
        _waveterm_si_restore_status $_waveterm_si_status
        if functions -q _waveterm_si_user_prompt
            _waveterm_si_user_prompt
        end
        return
    end
    if test $_WAVETERM_SI_FIRSTPROMPT -eq 1
        set -l uname_info (uname -smr 2>/dev/null)
        printf '\033]16162;M;{"shell":"fish","shellversion":"%s","uname":"%s","integration":true}\007' $FISH_VERSION "$uname_info"
        # OSC 7 only sent on first prompt - chpwd hook handles directory changes
        _waveterm_si_osc7
    else
        # 133;D/A/C dual-emit: the xterm frontend consumes standard FinalTerm
        # markers directly; 16162 stays for the Go-side Tracker (see docs/terax-terminal-port.md D4)
        printf '\033]16162;D;{"exitcode":%d}\007' $_waveterm_si_status
        printf '\033]133;D;%d\007' $_waveterm_si_status
    end
    _waveterm_si_emit_env
    printf '\033]16162;A\007'
    printf '\033]133;A\007'
    set -g _WAVETERM_SI_FIRSTPROMPT 0
    if test -n "$WAVETERM_BLOCKS"
        if test $_WAVETERM_SI_BLOCK_SEEN -eq 1
            printf '\n\n'
        else
            printf '\n'
        end
        printf '\033]133;B\007'
        return
    end
    _waveterm_si_restore_status $_waveterm_si_status
    if functions -q _waveterm_si_user_prompt
        _waveterm_si_user_prompt
    else
        printf '%s > ' (prompt_pwd)
    end
    printf '\033]133;B\007'
end

function _waveterm_si_preexec --on-event fish_preexec
    _waveterm_si_blocked; and return
    set -g _WAVETERM_SI_BLOCK_SEEN 1
    set -l cmd (string join -- ' ' $argv)
    set -l marker_cmd (string replace -ra '[\x00-\x1f\x7f]' ' ' -- "$cmd")
    set -l cmd_length (string length -- "$cmd")
    if test $cmd_length -gt 8192
        set -l cmd64 (printf '# command too large (%d bytes)' $cmd_length | base64 2>/dev/null | string replace -a '\n' '' | string replace -a '\r' '')
        printf '\033]16162;C;{"cmd64":"%s"}\007' "$cmd64"
    else
        set -l cmd64 (printf '%s' "$cmd" | base64 2>/dev/null | string replace -a '\n' '' | string replace -a '\r' '')
        if test -n "$cmd64"
            printf '\033]16162;C;{"cmd64":"%s"}\007' "$cmd64"
        else
            printf '\033]16162;C\007'
        end
    end
    printf '\033]133;C;%s\007' (string sub -l 256 -- "$marker_cmd")
end

# Also update on directory change
function _waveterm_si_chpwd --on-variable PWD
    _waveterm_si_osc7
end
