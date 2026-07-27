# add wsh to path, source dynamic script from wsh token
WAVETERM_WSHBINDIR={{.WSHBINDIR}}
export PATH="$WAVETERM_WSHBINDIR:$PATH"
source <(wsh token "$WAVETERM_SWAPTOKEN" zsh 2>/dev/null)
unset WAVETERM_SWAPTOKEN

# Source the original zshrc only if ZDOTDIR has not been changed
if [ "$ZDOTDIR" = "$WAVETERM_ZDOTDIR" ]; then
  [ -f ~/.zshrc ] && source ~/.zshrc
fi

if [[ ":$PATH:" != *":$WAVETERM_WSHBINDIR:"* ]]; then
  export PATH="$WAVETERM_WSHBINDIR:$PATH"
fi
unset WAVETERM_WSHBINDIR

if [[ -n ${_comps+x} ]]; then
  source <(wsh completion zsh)
fi

# fix history (macos)
if [[ "$HISTFILE" == "$WAVETERM_ZDOTDIR/.zsh_history" ]]; then
  HISTFILE="$HOME/.zsh_history"
fi

typeset -g _WAVETERM_SI_FIRSTPRECMD=1
typeset -g _WAVETERM_SI_BLOCK_SEEN=0
typeset -g _WAVETERM_SI_PS1_INJECTED=0

# shell integration
_waveterm_si_blocked() {
  [[ -n "$TMUX" || -n "$STY" || "$TERM" == tmux* || "$TERM" == screen* ]]
}

_waveterm_si_urlencode() {
  if (( $+functions[omz_urlencode] )); then
    omz_urlencode "$1"
  else
    local s="$1"
    # Escape % first
    s=${s//\%/%25}
    # Common reserved characters in file paths
    s=${s//\ /%20}
    s=${s//\#/%23}
    s=${s//\?/%3F}
    s=${s//\&/%26}
    s=${s//\;/%3B}
    s=${s//\+/%2B}
    printf '%s' "$s"
  fi
}

_waveterm_si_compmode() {
  # fzf-based completion wins
  if typeset -f _fzf_tab_complete >/dev/null 2>&1 || typeset -f _fzf_complete >/dev/null 2>&1; then
    echo "fzf"
    return
  fi

  # Check zstyle menu setting
  local _menuval
  if zstyle -s ':completion:*' menu _menuval 2>/dev/null; then
    if [[ "$_menuval" == *select* ]]; then
      echo "menu-select"
    else
      echo "menu"
    fi
    return
  fi

  echo "standard"
}

_waveterm_si_osc7() {
  _waveterm_si_blocked && return
  local encoded_pwd=$(_waveterm_si_urlencode "$PWD")
  printf '\033]7;file://localhost%s\007' "$encoded_pwd"  # OSC 7 - current directory
}

# Collect prompt-time environment (git branch, working tree diff, venv,
# node_version, conda) and emit them as an OSC 133 P sequence so the
# frontend's block-handler.applyPrecmdKv can populate the context chips.
# Mirrors warp's prompt_render_helper precmd block: warp executes the same
# `git symbolic-ref` / `git rev-parse` fallback to fetch the branch, and
# `git diff --shortstat HEAD` for the diff counts.  See
# warp/app/src/context_chips/builtins.rs:127-187 for the original source.
# Empty values are skipped so a non-git cwd emits a slim sequence.
_waveterm_si_emit_env() {
  _waveterm_si_blocked && return
  local parts="cwd=$(_waveterm_si_urlencode "$PWD")"

  if command -v git >/dev/null 2>&1; then
    local _git_branch
    _git_branch=$(GIT_OPTIONAL_LOCKS=0 git symbolic-ref --short HEAD 2>/dev/null) || \
      _git_branch=$(GIT_OPTIONAL_LOCKS=0 git rev-parse --short HEAD 2>/dev/null)
    if [ -n "$_git_branch" ]; then
      parts="${parts};git_branch=$(_waveterm_si_urlencode "$_git_branch")"
      local _diff
      _diff=$(GIT_OPTIONAL_LOCKS=0 git -c diff.autoRefreshIndex=false diff --shortstat HEAD 2>/dev/null)
      if [ -n "$_diff" ]; then
        parts="${parts};git_diff_stats=$(_waveterm_si_urlencode "$_diff")"
      fi
    fi
  fi

  if [ -n "$VIRTUAL_ENV" ]; then
    parts="${parts};venv=$(_waveterm_si_urlencode "${VIRTUAL_ENV##*/}")"
  fi
  if [ -n "$CONDA_DEFAULT_ENV" ]; then
    parts="${parts};conda=$(_waveterm_si_urlencode "$CONDA_DEFAULT_ENV")"
  fi
  if [ -n "$NODE_VERSION" ]; then
    parts="${parts};node_version=$(_waveterm_si_urlencode "$NODE_VERSION")"
  fi

  printf '\033]133;P;%s\007' "$parts"
}

_waveterm_si_precmd() {
  local _waveterm_si_status=$?
  _waveterm_si_blocked && return
  # D;status for previous command (skip before first prompt)
  # 133;D/A/C dual-emit: the xterm frontend consumes standard FinalTerm
  # markers directly; 16162 stays for the Go-side Tracker (see docs/terax-terminal-port.md D4)
  if (( !_WAVETERM_SI_FIRSTPRECMD )); then
    printf '\033]16162;D;{"exitcode":%d}\007' "$_waveterm_si_status"
    printf '\033]133;D;%d\007' "$_waveterm_si_status"
  else
    local uname_info=$(uname -smr 2>/dev/null)
    local omz=false
    local comp=$(_waveterm_si_compmode)
    [[ -n "$ZSH" && -r "$ZSH/oh-my-zsh.sh" ]] && omz=true
    printf '\033]16162;M;{"shell":"zsh","shellversion":"%s","uname":"%s","integration":true,"omz":%s,"comp":"%s"}\007' "$ZSH_VERSION" "$uname_info" "$omz" "$comp"
    # OSC 7 only sent on first prompt - chpwd hook handles directory changes
    _waveterm_si_osc7
  fi
  # Context-chip data — emitted every prompt so the chips track branch /
  # diff / venv changes mid-session.
  _waveterm_si_emit_env
  if [[ -n "$WAVETERM_BLOCKS" ]]; then
    if (( _WAVETERM_SI_BLOCK_SEEN )); then
      PS1=$'\n\n%{\033]133;B\007%}'
    else
      PS1=$'\n%{\033]133;B\007%}'
    fi
  elif (( !_WAVETERM_SI_PS1_INJECTED )); then
    PS1=$'%{\033]133;B\007%}'"$PS1"
    _WAVETERM_SI_PS1_INJECTED=1
  fi
  printf '\033]16162;A\007'
  printf '\033]133;A\007'
  _WAVETERM_SI_FIRSTPRECMD=0
}

_waveterm_si_preexec() {
  _waveterm_si_blocked && return
  _WAVETERM_SI_BLOCK_SEEN=1
  local cmd="$1"
  local marker_cmd="${1//[[:cntrl:]]/ }"
  local cmd_length=${#cmd}
  if [ "$cmd_length" -gt 8192 ]; then
    cmd=$(printf '# command too large (%d bytes)' "$cmd_length")
  fi
  local cmd64
  cmd64=$(printf '%s' "$cmd" | base64 2>/dev/null | tr -d '\n\r')
  if [ -n "$cmd64" ]; then
    printf '\033]16162;C;{"cmd64":"%s"}\007' "$cmd64"
  else
    printf '\033]16162;C\007'
  fi
  printf '\033]133;C;%s\007' "${marker_cmd[1,256]}"
}

typeset -g WAVETERM_SI_INPUTEMPTY=1

_waveterm_si_inputempty() {
  _waveterm_si_blocked && return
  
  local current_empty=1
  if [[ -n "$BUFFER" ]]; then
    current_empty=0
  fi
  
  if (( current_empty != WAVETERM_SI_INPUTEMPTY )); then
    WAVETERM_SI_INPUTEMPTY=$current_empty
    if (( current_empty )); then
      printf '\033]16162;I;{"inputempty":true}\007'
    else
      printf '\033]16162;I;{"inputempty":false}\007'
    fi
  fi
}

autoload -Uz add-zle-hook-widget 2>/dev/null
if (( $+functions[add-zle-hook-widget] )); then
  add-zle-hook-widget zle-line-init _waveterm_si_inputempty
  add-zle-hook-widget zle-line-pre-redraw _waveterm_si_inputempty
fi

autoload -U add-zsh-hook
add-zsh-hook precmd  _waveterm_si_precmd
add-zsh-hook preexec _waveterm_si_preexec
add-zsh-hook chpwd   _waveterm_si_osc7
