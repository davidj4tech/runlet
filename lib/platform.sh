# Platform-specific runner plumbing. Bash 3.2 compatible for stock macOS.
runlet_platform_init() {
  RUNLET_OS=$(uname -s)
  RUNLET_PROCESS_DEP=setsid
  if [[ "$RUNLET_OS" == Darwin ]]; then
    # The installer records custom prefixes too. No brew invocation per poll.
    local prefix="${RUNLET_BREW_PREFIX:-}"
    if [[ -z "$prefix" ]]; then
      if [[ -d /opt/homebrew ]]; then prefix=/opt/homebrew; else prefix=/usr/local; fi
    fi
    export PATH="$prefix/opt/coreutils/libexec/gnubin:$prefix/opt/openssl@3/bin:$prefix/bin:$HOME/.local/bin:$PATH"
    RUNLET_PROCESS_DEP=python3
  fi
}

runlet_start_session() {
  if [[ "$RUNLET_OS" == Darwin ]]; then
    # This supervisor stays in launchd's process group, so unloading/restarting
    # the service also terminates commands in their separate session.
    python3 "$HERE/lib/macos-job.py" "$@"
  else
    setsid "$@"
  fi
}

runlet_load_average() {
  if [[ "$RUNLET_OS" == Darwin ]]; then
    sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}'
  else
    cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0
  fi
}
