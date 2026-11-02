#!/usr/bin/env bash
#
# Provision a machine to develop Nimbus Tab DVR.
#
#   ./provision.sh          a development Mac: the toolchain, the git hooks, both GitHub accounts
#   ./provision.sh dev      the same thing, named
#   ./provision.sh check    report what is installed and what is missing, change nothing
#
# Re-running is the documented way to repair or extend an installation: every step checks
# before it installs. Nothing here is run by a CI job; CI installs its own tools.
#
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# shellcheck source=scripts/lib/output.sh
source scripts/lib/output.sh

# The tools every checkout needs. Node carries the TypeScript toolchain through npm; Go builds
# the demo backend; ffmpeg supplies ffprobe for the capture spike tests; the
# rest is the repository's own checks and the GitHub flow.
BREW_PACKAGES=(prek shellcheck gh jq node go ffmpeg)

# The two GitHub accounts a dev machine needs. Niels reviews as himself; agents post as the
# second account, so a pull request does not read as one person talking to themselves, and so
# GitHub allows Approve and Request changes on a pull request an agent opened.
# See scripts/gh-agent.sh.
GH_PERSONAL_USER="${GH_PERSONAL_USER:-njoubert}"
GH_AGENT_USER="${GH_AGENT_USER:-njoubert-agents}"

require_macos() {
    if [[ "$OSTYPE" != "darwin"* ]]; then
        print_error "provisioning targets macOS with Homebrew"
        print_info "on Linux, install ${BREW_PACKAGES[*]} by hand and run: prek install"
        exit 1
    fi
    if ! command_exists brew; then
        print_error "Homebrew is required"
        print_info "install it with the one-liner at https://brew.sh, then run this again"
        exit 1
    fi
}

install_toolchain() {
    print_header "Toolchain (Homebrew)"
    stage "installing the Homebrew packages"

    local missing=() pkg
    for pkg in "${BREW_PACKAGES[@]}"; do
        if ! brew list --formula "$pkg" >/dev/null 2>&1; then
            missing+=("$pkg")
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        print_info "installing: ${missing[*]}"
        brew install "${missing[@]}"
    fi

    print_success "prek $(prek --version | awk '{print $2}'), shellcheck $(shellcheck --version | awk '/^version:/{print $2}'), gh $(gh --version | awk 'NR==1{print $3}'), jq $(jq --version), node $(node --version), $(go version | awk '{print $3}'), ffmpeg $(ffmpeg -version | awk 'NR==1{print $3}')"
}

install_node_modules() {
    print_header "Node modules (npm)"
    stage "installing the npm packages"

    npm ci --no-audit --no-fund
    print_success "node_modules from package-lock.json"

    stage "installing Playwright's Chromium"
    npx playwright install chromium
    print_success "Playwright chromium $(npx playwright --version | awk '{print $2}')"
}

install_hooks() {
    print_header "Git hooks (prek)"
    stage "installing the prek hooks"

    prek install
    print_success "hooks installed from .pre-commit-config.yaml"
    print_info "every commit is checked; CI runs the same set with: prek run --all-files"
}

ensure_gh_account() {
    local user=$1 role=$2

    if gh auth token --user "$user" >/dev/null 2>&1; then
        print_success "gh authenticated as $user ($role)"
        return 0
    fi

    print_warning "gh has no login for $user ($role)"
    read -r -p "  Log in as $user now (opens a browser)? (Y/n): " -n 1
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        print_warning "skipped; run 'gh auth login' and choose $user later"
        return 0
    fi

    print_info "sign in as $user in the browser that opens, not as anyone else"
    gh auth login || print_warning "the login did not complete for $user"
}

install_gh_accounts() {
    print_header "GitHub accounts"
    stage "logging in both GitHub accounts"

    # gh holds several accounts at once, so this asks for each in turn and then restores the
    # personal one as active.
    ensure_gh_account "$GH_PERSONAL_USER" "your own reviews"
    ensure_gh_account "$GH_AGENT_USER" "what agents post"

    # `gh auth login` leaves the account it just added active, so the second login would
    # quietly make every later command Niels types come from the agent. Put the personal
    # account back; agents reach the other one explicitly through scripts/gh-agent.sh, never
    # by switching.
    if gh auth token --user "$GH_PERSONAL_USER" >/dev/null 2>&1; then
        if gh auth switch --user "$GH_PERSONAL_USER" >/dev/null 2>&1; then
            print_success "active gh account: $GH_PERSONAL_USER"
        else
            print_warning "could not make $GH_PERSONAL_USER the active gh account"
            print_info "run: gh auth switch --user $GH_PERSONAL_USER"
        fi
    fi
}

report() {
    print_header "Installed"

    local pkg gaps=0
    for pkg in "${BREW_PACKAGES[@]}" git; do
        if command_exists "$pkg"; then
            print_success "$pkg: $(command -v "$pkg")"
        else
            print_warning "$pkg is missing"
            gaps=1
        fi
    done

    if [ -d node_modules ] && [ -x node_modules/.bin/vite ]; then
        print_success "node_modules is installed"
    else
        print_warning "node_modules is missing; run ./provision.sh"
        gaps=1
    fi

    local hook
    for hook in pre-commit pre-push; do
        if [ -f ".git/hooks/$hook" ] && grep -q prek ".git/hooks/$hook" 2>/dev/null; then
            print_success "prek $hook hook is installed"
        else
            print_warning "the prek $hook hook is not installed; run ./provision.sh"
            gaps=1
        fi
    done

    local user
    for user in "$GH_PERSONAL_USER" "$GH_AGENT_USER"; do
        if command_exists gh && gh auth token --user "$user" >/dev/null 2>&1; then
            print_success "gh is logged in as $user"
        else
            print_warning "gh has no login for $user; run ./provision.sh"
            gaps=1
        fi
    done

    if [ "$gaps" -eq 0 ]; then
        result "this machine is provisioned"
        return 0
    fi
    result "something is missing"
    return 1
}

cmd="${1:-dev}"
install_traps "./provision.sh $cmd"

case "$cmd" in
    dev)
        require_macos
        install_toolchain
        install_node_modules
        install_hooks
        install_gh_accounts
        # A skipped login is a choice, so the run stays green and the ⚠ lines say what is left.
        if report; then
            result "provisioned for development"
        else
            result "provisioned, and the warnings above say what is still missing"
        fi
        ;;

    check)
        # The gate, so a gap is a failure here even though it is only a warning above.
        report || exit 1
        ;;

    *)
        print_usage_from_header "$0" >&2
        exit 2
        ;;
esac
