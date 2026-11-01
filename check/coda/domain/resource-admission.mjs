import { requireCondition as check } from './errors.mjs';

export const admissionFeatures = Object.freeze({ multiResource: false, multiUnit: false, exclusive: true });

export function admissionRequest(request) {
  check(request && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(key => ['requestId', 'group', 'resources', 'exclusive'].includes(key)), 'invalid_input', '无效的资源申请');
  const { requestId, group, resources, exclusive = false } = request;
  check(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 500, 'invalid_input', 'requestId 须为 1–500 字的稳定申请标识');
  check(typeof group === 'string' && group.length > 0 && group.length <= 100, 'invalid_input', 'group 须为本机组名');
  check(resources && Object.keys(resources).length === 1 && resources.slots === 1 && !Array.isArray(resources),
    'invalid_input', '只支持 resources: { slots: 1 }，不支持多资源或多单位');
  check(typeof exclusive === 'boolean', 'invalid_input', 'exclusive 须为 boolean');
  return { requestId, group, exclusive };
}
