import { admissionFeatures } from '../domain/resource-admission.mjs';

// The module's local ledger API, exported unchanged to plugin-check.
export function admissionAPI(call) {
  return {
    features: admissionFeatures,
    acquire: request => call('acquire', [request]),
    release: lease => call('release', [lease]),
    list: () => call('list', []),
  };
}
