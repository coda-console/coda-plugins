#!/bin/sh
# The Kimi CLI's own installer, as https://www.kimi.com/code gives it. It puts the CLI in ~/.kimi-code/bin, where Coda looks
# first, and would add that to the shell's configuration and rename an older Python `kimi` it finds on the PATH: told not to
# touch the configuration, with that directory not on the PATH, it leaves both alone. It installs KIMI_VERSION, which setup.mjs
# sets to the version the relay was checked against; the latest without it.
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx "$HOME/.kimi-code/bin" | paste -sd: -)
KIMI_NO_MODIFY_PATH=1 PATH="$PATH" exec bash -c 'set -o pipefail; curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'
