// codex-acp 1.12.0 has no mode in which Codex asks the user before everything but its trusted commands: its "read-only" is
// `on-request`, where the model itself decides what to ask about. Coda's manual approval tier needs the real thing, so this adds the
// mode `manual` to the adapter's one AgentMode table (the mode list, `session/set_mode`, `session/set_config_option` and the
// config options all read it): `untrusted` approval, the user as reviewer, a workspace-write sandbox without network. Fail loudly
// on an adapter upgrade.
const patches = [
  [`  static DEFAULT_AGENT_MODE = _AgentMode.Agent;`, `  static Manual = new _AgentMode(
    "manual",
    "Manual approval",
    "Ask before running anything outside Codex's trusted commands",
    "standard",
    "untrusted",
    "user",
    {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    "workspace-write"
  );
  static DEFAULT_AGENT_MODE = _AgentMode.Agent;`],
  ['    return [_AgentMode.ReadOnly, _AgentMode.Agent, _AgentMode.AgentFullAccess];',
    '    return [_AgentMode.Manual, _AgentMode.ReadOnly, _AgentMode.Agent, _AgentMode.AgentFullAccess];'],
];
export function manualCodexApproval(source) {
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error('codex-acp manual approval mode patch no longer matches the locked adapter');
    source = source.replace(before, () => after);
  }
  return source;
}
