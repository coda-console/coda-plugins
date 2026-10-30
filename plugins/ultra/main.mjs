// The Ultra plugin's module (README.md): the composer mode's hooks, in a session's composer or a new task's. Entering offers
// the templates the setting lists; choosing one fills the list, changing the list makes it the user's own. The agent is
// told it is on with the first message sent in it and whenever the parameters changed since the last one, reminded every
// ten messages, and told it is off as the mode is left. What goes with a message Coda tells only once that message is taken.
import { CUSTOM, OFF, REMIND_EVERY, STILL_ON, on, templateName, templateValue, templates, withTemplates } from './ultra.mjs';

export function activate(coda) {
  const read = async projectId => templates(JSON.parse((await coda.environment(projectId)).CODA_PLUGIN_SETTINGS ?? '{}')['ultra.templates']);
  coda.composerModes.register('ultra', {
    // Its parameters as declared, the templates among them those the setting lists now.
    async enter({ projectId, parameters }) {
      const all = await read(projectId), [first] = all.keys();
      return { parameters: withTemplates(parameters, [...all.keys()]),
        values: { template: first === undefined ? CUSTOM : templateValue(first), subagents: all.get(first) ?? [] } };
    },
    async change({ projectId, values, changed }) {
      if (changed !== 'template') return { values: { ...values, template: CUSTOM } };
      const name = templateName(values.template), rows = name === null ? undefined : (await read(projectId)).get(name);
      return { values: rows ? { ...values, subagents: rows } : values };
    },
    send({ values, sent, changedSinceSent }) {
      if (sent === 0 || changedSinceSent) return { tell: on(values.subagents ?? []) };
      return sent % REMIND_EVERY === 0 ? { tell: STILL_ON } : null;
    },
    // Left in a new task's composer nothing was sent: there is no session, nor anything to take back.
    async exit({ session, sent }) {
      if (session && sent > 0) await coda.tell(session.id, OFF);
    },
  });
}
