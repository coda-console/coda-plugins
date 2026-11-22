// A blob pointer (docs/plugins.md「Blob 指针」, protocol `parseBlobPath`) to content of one of plugin `plugin`'s own services,
// on the backend `owner`, as `coda.pointer` gives it: `path` as it is below the service, not encoded, its segments
// between `/`; `extra`, what it says of the content. One that is no pointer is a TypeError that says why.
import { parseBlobPath } from '@coda-console/protocol/blob';
import { checkServiceId } from '../domain/plugin-services.mjs';

const EXTRA = ['name', 'size', 'mime', 'sha256'];
export function blobPointer(owner, plugin, service, path, extra = {}) {
  checkServiceId(service);
  if (typeof path !== 'string' || extra === null || typeof extra !== 'object' || Array.isArray(extra)) throw new TypeError('pointer(服务, 路径, { name?, size?, mime?, sha256? }?)');
  const other = Object.keys(extra).find(key => !EXTRA.includes(key));
  if (other !== undefined) throw new TypeError(`pointer 的附加只收 ${EXTRA.join('、')}，没有 ${other}`);
  const refuse = why => { throw new TypeError(`pointer 的路径${why}：${JSON.stringify(path).slice(0, 200)}`); };
  const segments = path.split('/');
  if (segments.includes('')) refuse('有空段');
  if (segments.some(segment => segment === '.' || segment === '..')) refuse('有 . 或 .. 段');
  if (path.includes('\\')) refuse('有「\\」');
  if (!path.isWellFormed()) refuse('不是合法的 Unicode 文本');
  const encoded = `plugins/${plugin}/services/${service}/${segments.map(encodeURIComponent).join('/')}`;
  if (!parseBlobPath(encoded)) refuse('编码后过长');
  return { owner, path: encoded, ...extra };
}
