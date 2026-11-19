// Coda's own protocol of the plugins installed here, `coda/plugin@1`: what each is and how it stands on this machine, as a
// record. A record is an installed plugin, its ID the plugin's; it has no operation. Its records are read through from the
// `plugins` table (Protocols.serve) by what the plugins component says of them (components/plugins/plugins.mjs `installedView`):
// nothing is kept of them besides, and they are no section and not in the record directory.
import { createHash } from 'node:crypto';
import { canonical } from '../domain/values.mjs';

export const PLUGIN = 'coda/plugin@1';

const text = { type: 'string' };

export const PLUGIN_PROTOCOL = {
  kind: PLUGIN,
  title: '插件',
  // Its name and version, and where it comes from: an npm package, a Git repository (at a branch and a commit), or Coda's own copy.
  spec: {
    type: 'object',
    properties: {
      name: text,
      version: text,
      source: {
        type: 'object',
        properties: { kind: { enum: ['builtin', 'npm', 'git'] }, package: text, version: text, repo: text, path: text, ref: text, commit: text },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    required: ['name', 'version', 'source'],
    additionalProperties: false,
  },
  // How it is on this machine: ready, being taken (`fetching`), not running here (`incompatible`) or failed, and why (`error`).
  status: {
    type: 'object',
    properties: { state: { enum: ['ready', 'fetching', 'incompatible', 'failed'] }, error: text },
    required: ['state'],
    additionalProperties: false,
  },
  operations: {},
  // What a plugin may ask for in its `uses` (docs/plugins.md「用到的权限」), on trial while the protocol is not stable.
  permissions: {
    read: { title: '查看这台机器装了哪些插件', trial: true, read: true },
  },
};

const SOURCE_KEYS = ['package', 'version', 'repo', 'path', 'ref', 'commit'];
// The record of one installed plugin, as `installedView` says it; its revision is what its spec and status say.
const record = ({ id, installedAt, sequence, name, version, source, local }) => {
  const spec = { name, version, source: { kind: source.kind ?? 'builtin', ...Object.fromEntries(SOURCE_KEYS.filter(key => typeof source[key] === 'string').map(key => [key, source[key]])) } };
  const status = { state: local.state, ...(local.error ? { error: local.error } : {}) };
  return { kind: PLUGIN, id, provider: 'coda', instance: id, createdAt: new Date(installedAt).toISOString(), creationSequence: sequence, spec, status,
    revision: `${id}:${createHash('sha256').update(canonical([spec, status])).digest('hex').slice(0, 16)}` };
};
export const pluginRecords = plugins => ({
  get: id => { const view = plugins.installedView().find(each => each.id === id); return view ? record(view) : null; },
  list: () => plugins.installedView().map(record),
});
