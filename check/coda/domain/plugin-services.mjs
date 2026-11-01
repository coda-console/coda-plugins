// Shared with plugin-check: service names are local to one plugin.
export function checkServiceId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id))
    throw new TypeError('服务 ID 是小写字母、数字和「-」，以字母开头，至多 40 个字符');
}
