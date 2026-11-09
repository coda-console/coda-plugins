// What the model services take of plugins (components/plugins/contribution-points.mjs, model-services.mjs): the services a
// plugin provides (docs/plugins.md「模型服务」, schemas/model-providers.json), each with the setting its key is, defined as
// this module loads.
// Descriptions only: nothing here imports a component, for the plugins read with them are read before any is made.
import { defineContributionPoint } from './contribution-points.mjs';
import { SCHEMAS } from '@coda-console/protocol/validate';

defineContributionPoint({ key: 'modelProviders', schema: SCHEMAS['model-providers.json'], read: raw => raw?.length ? { modelProviders: raw.map(p => ({ id: p.id, title: p.title.trim(), api: p.api, url: p.url,
  ...(p.key ? { key: /^\$\{config:([^}]+)\}$/.exec(p.key)[1] } : {}) })) } : {} });
