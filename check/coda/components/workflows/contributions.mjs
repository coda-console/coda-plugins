// What workflows take of plugins (components/plugins/contribution-points.mjs): the capabilities a plugin's workflows
// stand for (schemas/capabilities.json), defined as this module loads. The events it publishes are its protocols'
// (components/protocols/protocol-events.mjs).
// Its concurrency groups are its coda/group@1 records (components/concurrency-groups/schemas.mjs), not of its manifest.
// Descriptions only: nothing here imports a component, for the plugins read with them are read before any is made.
import { defineContributionPoint } from '../plugins/contribution-points.mjs';
import { SCHEMAS } from '@coda-console/protocol/validate';

defineContributionPoint({ key: 'capabilities', schema: SCHEMAS['capabilities.json'], read: (raw = []) => ({ capabilities: [...raw].sort() }),
  confirm: plugin => ({ capabilities: plugin.capabilities }) });
