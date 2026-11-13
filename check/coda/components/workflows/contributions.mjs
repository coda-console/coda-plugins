// What workflows take of plugins (components/plugins/contribution-points.mjs): the capabilities a plugin's workflows
// stand for (schemas/capabilities.json), its concurrency groups (schemas/groups.json) and the events it publishes
// (schemas/events.json), defined as this module loads.
// Descriptions only: nothing here imports a component, for the plugins read with them are read before any is made.
import { defineContributionPoint } from '../plugins/contribution-points.mjs';
import { SCHEMAS } from '@coda-console/protocol/validate';

defineContributionPoint({ key: 'capabilities', schema: SCHEMAS['capabilities.json'], read: (raw = []) => ({ capabilities: [...raw].sort() }),
  confirm: plugin => ({ capabilities: plugin.capabilities }) });
// A group is one plugin's: any process takes it by its name.
defineContributionPoint({ key: 'groups', schema: SCHEMAS['groups.json'], read: (raw = []) => ({ groups: raw.map(g => ({ name: g.name, capacity: g.capacity })) }),
  claim: plugin => plugin.groups.map(g => `组 ${g.name}`),
  confirm: plugin => ({ groups: plugin.groups.map(g => ({ name: g.name, capacity: g.capacity })) }) });
defineContributionPoint({ key: 'events', schema: SCHEMAS['events.json'], read: raw => raw?.length ? { events: raw.map(e => ({ name: e.name, starts: e.starts !== false, ...(e.ends ? { ends: true } : {}) })) } : {} });
