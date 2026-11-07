#!/bin/sh
# The「Kimi」resource type's login (`signIn`): `kimi login`, the device-code login of the CLI the agent runs. `kimi login` opens the
# link with `open` (`xdg-open` on Linux) whatever BROWSER says: on a machine the user is not at, that would be a page left
# open for no one, so it finds do-nothing ones first on its PATH, in this plugin's own state.
stubs="$CODA_PLUGIN_STATE/no-browser"
mkdir -p "$stubs" && for name in open xdg-open; do printf '#!/bin/sh\nexit 0\n' > "$stubs/$name" && chmod 755 "$stubs/$name"; done || exit 1
k="$HOME/.kimi-code/bin/kimi"; [ -x "$k" ] || k=kimi
PATH="$stubs:$PATH" NO_COLOR=1 exec "$k" login
