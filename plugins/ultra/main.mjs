// The Ultra plugin's module (README.md): the composer mode's hooks. Entering offers the templates the setting lists; choosing
// one fills the list, changing the list makes it the user's own. The agent is told it is on with the first message sent in
// it and whenever the list changed since, reminded every ten messages, and told it is off as the mode is left.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUSTOM, OFF, REMIND_EVERY, STILL_ON, on, templates, withTemplates } from './ultra.mjs';

export function activate(coda) {
  const declared = JSON.parse(readFileSync(join(coda.plugin.path, 'package.json'), 'utf8')).contributes.composerModes.find(m => m.id === 'ultra').parameters;
  // What each session's agent was last told the list is: told again once it is another. Lost with the host, it is told again.
  const told = new Map();
  const read = async projectId => templates(JSON.parse((await coda.environment(projectId)).CODA_PLUGIN_SETTINGS ?? '{}')['ultra.templates']);
  coda.composerModes.register('ultra', {
    async enter({ session }) {
      const all = await read(session.projectId), [first] = all.keys();
      return { parameters: withTemplates(declared, [...all.keys()]), values: { template: first ?? CUSTOM, subagents: all.get(first) ?? [] } };
    },
    async change({ session, values, changed }) {
      if (changed !== 'template') return { values: { ...values, template: CUSTOM } };
      const rows = (await read(session.projectId)).get(values.template);
      return { values: rows ? { ...values, subagents: rows } : values };
    },
    async send({ session, values, sent }) {
      const list = values.subagents ?? [], said = JSON.stringify(list);
      if (sent === 0 || told.get(session.id) !== said) {
        told.set(session.id, said);
        await coda.tell(session.id, on(list));
      } else if (sent % REMIND_EVERY === 0) await coda.tell(session.id, STILL_ON);
    },
    async exit({ session, sent }) {
      told.delete(session.id);
      if (sent > 0) await coda.tell(session.id, OFF);
    },
  });
}
