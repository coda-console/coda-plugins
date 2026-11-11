import { admissionFeatures } from '../domain/resource-admission.mjs';

// The module's local ledger API, exported unchanged to plugin-check.
export function admissionAPI(call, handlers = new Map()) {
  return {
    handle(operation, fn) {
      if (!['lend', 'return'].includes(operation) || typeof fn !== 'function') throw new TypeError('resources.handle(lend|return, fn)');
      if (handlers.has(operation)) throw new TypeError(`资源钩子已登记：${operation}`);
      handlers.set(operation, fn);
      return { dispose: () => handlers.delete(operation) };
    },
    declareEntities: entities => call('declareEntities', [entities]),
    declareLinks: links => call('declareLinks', [links]),
    links: entity => call('links', [entity]),
    features: admissionFeatures,
    declareGroups: groups => call('declareGroups', [groups]),
    groupOwner: name => call('groupOwner', [name]),
    acquire: request => call('acquire', [request]),
    release: lease => call('release', [lease]),
    list: () => call('list', []),
  };
}
