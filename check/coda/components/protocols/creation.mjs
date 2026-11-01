// Holder-owned envelope fields. Sequence orders originals across kinds on one holder; time is only for display.
import { requireCondition as check } from '../../domain/errors.mjs';

export const creationProperties = {
  createdAt: { type: 'string' },
  creationSequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
};

export function creationOf(object) {
  const { createdAt, creationSequence } = object;
  check(typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt))
    && Number.isSafeInteger(creationSequence) && creationSequence > 0, 'invalid_input', '协议对象缺少有效的创建信息');
  return { createdAt, creationSequence };
}

export function checkCreationReadOnly(object) {
  check(Object.keys(creationProperties).every(key => !Object.hasOwn(object, key)), 'invalid_input', '创建信息由持有方写入，只读');
}
