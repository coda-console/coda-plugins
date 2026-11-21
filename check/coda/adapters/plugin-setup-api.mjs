// What a plugin's module is given as `coda.pluginSetup` (adapters/plugin-modules.mjs `codaFor`; answered by components/plugins/plugin-setup.mjs `setupRequests`): `retry(plugin)`,
// an installed plugin's setup run again, asked as the module's own plugin, never as that one.
export function pluginSetupAPI(call) {
  return { retry: plugin => call('retry', [plugin]) };
}
