// The contract check of one plugin directory: the manifest, then each agent's handshake (and with `live`, a turn) and each
// panel's reading. The rules are Coda's own code (check/coda/), run where a plugin is written.
import { resolve } from 'node:path';
import { checkAgent } from './agent.mjs';
import { checkManifest } from './manifest.mjs';
import { checkPanel } from './panel.mjs';
import { Report } from './report.mjs';

// `agent`: only this agent of the plugin; `manifestOnly`: nothing is run; `live`: one turn each with `prompt`.
export async function checkPlugin(dir, { agent: only = null, manifestOnly = false, live = false, prompt, limits } = {}) {
  const pluginDir = resolve(dir), report = new Report();
  const plugin = checkManifest(pluginDir, report.scope('manifest'));
  if (!plugin) return { report, plugin };
  const agents = only ? plugin.agents.filter(a => a.id === only) : plugin.agents;
  if (only && !agents.length) report.scope('manifest').fail('options.agent', `清单里没有能检查的 Agent ${only}`);
  if (manifestOnly) {
    if (agents.length || plugin.panels.length) report.scope('handshake').skip('options.manifest', '只查清单（--manifest）：不启动 Agent、不读面板');
    return { report, plugin };
  }
  for (const agent of agents) await checkAgent({ agent, checked: plugin, live, prompt, limits, say: level => report.scope(level, `Agent ${agent.id}`) });
  if (!only) for (const panel of plugin.panels) await checkPanel({ panel, checked: plugin, say: report.scope('handshake', `面板 ${panel.id}`) });
  return { report, plugin };
}
