// The provider declaration contract, shared verbatim with plugin-check. No topology or runtime policy here.
import { ProtocolTypes } from './types.mjs';
import { requireCondition as check } from '../../domain/errors.mjs';

export function providerDefinition(input) {
  const { kind, spec, status, controllers = [], target = null } = input ?? {};
  check(Array.isArray(controllers) && controllers.every(id => typeof id === 'string' && id), 'invalid_input', 'controllers 须为插件 ID 列表');
  check(target === null || (typeof target === 'string' && Object.hasOwn(spec?.properties ?? {}, target)), 'invalid_input', 'target 须为 spec 声明的资源引用栏');
  new ProtocolTypes().register({ kind, spec, status, participants: () => [] });
  return structuredClone({ kind, spec, status, controllers, target });
}
