// The agents a plugin brings (docs/plugins.md「Agent」, schemas/agents.json): who each is, how the clients draw it, and how
// Coda starts its process, which speaks ACP with Coda's waits (coda-protocol docs/agent-protocol.md). Nothing here knows any agent by
// name: Codex and Claude are plugins like any other.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

// An icon file, read once with the plugin (its schema says it is a PDF in the plugin's directory): both clients draw it as
// they drew the brand artwork they shipped with.
const icon = (dir, path) => readFileSync(join(dir, normalize(path))).toString('base64');
// The PDFs an icon names (an agent's, or a plugin's own drawn the same way), read: light, dark when there is one, and
// whether it is drawn in the text colour.
export const iconFiles = (dir, spec) => ({ light: icon(dir, spec.light), ...(spec.dark !== undefined ? { dark: icon(dir, spec.dark) } : {}), template: spec.template === true });
// An icon as the clients are given it: PDFs as data, light and dark, and whether they take the text's color; a symbol on
// a colour as it is.
const pdf = data => data ? `data:application/pdf;base64,${data}` : null;
export const shownIcon = icon => icon.symbol ? { symbol: icon.symbol, color: icon.color } : { light: pdf(icon.light), dark: pdf(icon.dark), template: icon.template };
const MODES = ['title', 'unset', 'note', 'auto', 'full'];
// `contributes.agents` of the plugin in `dir`, as its schema has them.
export function agentDeclarations(raw = [], dir) {
  return raw.map(agent => ({
    id: agent.id, displayName: agent.displayName,
    icon: iconFiles(dir, agent.icon),
    command: agent.command,
    ...(agent.lifecycle !== undefined ? { lifecycle: agent.lifecycle } : {}),
    modes: Object.fromEntries(MODES.filter(key => agent.modes?.[key] !== undefined).map(key => [key, agent.modes[key]])),
    ...(agent.skillsDir !== undefined ? { skillsDir: normalize(agent.skillsDir) } : {}),
    configFiles: [...(agent.configFiles ?? [])],
    ...(agent.setupHint !== undefined ? { setupHint: agent.setupHint } : {}),
  }));
}
// A configuration file an agent reads its models from, as its plugin names it: `~/` is the home directory, `${VAR}` and
// `${VAR:-default}` the backend's environment (a variable empty and without a default leaves the file out), and a relative
// path is the project's.
export function configFile(spec, { env, home, root }) {
  let empty = false;
  const expanded = spec.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const value = env[name];
    if (value) return value;
    if (fallback === undefined) { empty = true; return ''; }
    return fallback;
  });
  if (empty || !expanded) return null;
  const path = expanded === '~' ? home : expanded.startsWith('~/') ? join(home, expanded.slice(2)) : expanded;
  return isAbsolute(path) ? path : join(root, path);
}
