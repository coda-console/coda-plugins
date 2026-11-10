// What sessions take of plugins (components/plugins/contribution-points.mjs): the agents a plugin brings (schemas/agents.json)
// and the settings naming one of them (`coda-agent`), what it tells every agent (instructions), the Agent Skills it lays
// into projects (skills), the commands it puts on their PATH (commands) and the MCP servers their agents start
// (mcpServers), defined as this module loads.
// Descriptions only: nothing here imports a component, for the plugins read with them are read before any is made.
import { join, normalize } from 'node:path';
import { defineContributionPoint } from '../plugins/contribution-points.mjs';
import { SCHEMAS } from '@coda-console/protocol/validate';
import { requireCondition as check, ContractError } from '../../domain/errors.mjs';
import { AGENT_ID } from '../../domain/values.mjs';
import { settings } from './commands.mjs';
import { iconFiles } from '../plugins/plugin-icons.mjs';
import { readSkillDocument } from '../plugins/skill-document.mjs';

const MODES = ['title', 'unset', 'note', 'auto', 'full'];
// `contributes.agents` of the plugin in `dir`, as its schema has them: who each is, how the clients draw it, and how Coda
// starts its process (components/plugins/agent-plugins.mjs).
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
// The Agent Skills it brings (docs/plugins.md「Skills」): directories of its own, each with its SKILL.md, named after the
// directory as the agents find them. They are laid into the working copy of each project it applies to.
export const SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function skills(raw, dir) {
  return raw.map(path => {
    const relative = normalize(path).replace(/\/+$/, ''), name = relative.split('/').at(-1);
    const skill = { name, path: join(dir, relative) };
    // Descriptions are for browsing only; a missing or unreadable document is explained when opened.
    try { skill.description = readSkillDocument({ dir, skills: [skill] }, name).description; } catch { /* Keep the declaration. */ }
    return skill;
  });
}

// A setting's value that is an Agent combination (`format: coda-agent`): the agent it names, with the settings a session of it
// starts with. Whether that agent is installed is asked where it is used (a review, a step): a setting stays readable while
// a plugin it names is uninstalled.
function agentValue(value, where, code) {
  check(value && typeof value === 'object' && !Array.isArray(value) && typeof value.agent === 'string' && AGENT_ID.test(value.agent), code,
    `${where} 须为 Agent 组合，并指明 Agent`);
  const { agent, ...rest } = value;
  try { return { agent, ...settings(rest) }; } catch (e) { throw new ContractError(code, `${where}：${e.message}`); }
}

// An agent is one plugin's: sessions name it by its ID alone. A plugin that draws no icon of its own and brings one agent
// is drawn as that agent.
defineContributionPoint({ key: 'agents', schema: SCHEMAS['agents.json'], read: (raw, dir) => ({ agents: agentDeclarations(raw, dir) }),
  claim: plugin => plugin.agents.map(a => `Agent ${a.id}`), icon: plugin => plugin.agents.length === 1 ? plugin.agents[0].icon : null,
  confirm: plugin => ({ agents: plugin.agents.map(a => ({ id: a.id, displayName: a.displayName, command: a.command })) }),
  formats: { 'coda-agent': agentValue } });
// Its words to every agent: a text as written, or a command whose output they are as each session opens
// (session-config/service.mjs pluginInstructions), declared as its other commands are (`{ command }`).
const INSTRUCTIONS = { title: SCHEMAS['instructions.json'].title, description: '一段文字（不超过 200 字），或 { command }：开会话时运行，输出拼进会话指令',
  anyOf: [{ $ref: 'instructions.json' }, { $ref: 'common.json#/$defs/commandHolder' }] };
defineContributionPoint({ key: 'instructions', schema: INSTRUCTIONS,
  read: raw => typeof raw === 'string' ? { instructions: raw.trim() } : raw ? { instructions: { command: raw.command } } : {},
  confirm: plugin => plugin.instructions ? { instructions: plugin.instructions } : {} });
// Confirmed by name, each with what its SKILL.md says it is for.
defineContributionPoint({ key: 'skills', schema: SCHEMAS['skills.json'], read: (raw, dir) => raw?.length ? { skills: skills(raw, dir) } : {},
  confirm: plugin => plugin.skills?.length ? { skills: plugin.skills.map(s => s.name),
    skillDescriptions: Object.fromEntries(plugin.skills.filter(s => s.description).map(s => [s.name, s.description])) } : {} });
defineContributionPoint({ key: 'commands', schema: SCHEMAS['commands.json'], read: (raw = []) => ({ commands: raw.map(c => ({ name: c.name, command: c.command })) }),
  confirm: plugin => ({ commands: plugin.commands.map(c => ({ name: c.name, command: c.command })) }) });
// Confirmed word for word: what they run and the variables they are given as written.
defineContributionPoint({ key: 'mcpServers', schema: SCHEMAS['mcp-servers.json'], read: raw => raw && Object.keys(raw).length ? { mcpServers: Object.entries(raw).map(([name, server]) => ({ name,
  command: server.command, args: [...(server.args ?? [])], env: Object.entries(server.env ?? {}).map(([variable, value]) => ({ name: variable, value })) })) } : {},
  confirm: plugin => plugin.mcpServers?.length ? { mcpServers: plugin.mcpServers.map(({ name, command, args, env }) => ({ name, command, args, env })) } : {} });
