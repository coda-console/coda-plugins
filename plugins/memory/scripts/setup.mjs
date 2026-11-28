// 插件的安装步骤（contributes.setup）：确保这台机器上有锁定版本的 mnemon（v0.2.15）。
// 设置里填了可执行的 mnemonPath、或状态目录里已有这个版本，就什么都不做；否则下载官方发布包，
// 核对写死的 SHA-256 后解出 mnemon，原子装到 <CODA_PLUGIN_STATE>/bin/mnemon。不通过校验的包立即删掉，非零退出。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, createWriteStream, realpathSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const VERSION = '0.2.15';
const BASE_URL = `https://github.com/mnemon-dev/mnemon/releases/download/v${VERSION}`;
const ASSETS = {
  'darwin/arm64': { name: `mnemon_${VERSION}_darwin_arm64.tar.gz`, sha256: '1463b0bfbedf96ddfa4b5d7e4cc4cea01d8836c7b65d829a7a9e1fb9363ffdc4' },
  'darwin/x64': { name: `mnemon_${VERSION}_darwin_amd64.tar.gz`, sha256: '4c4d844bd2b28765eae3edfd8cae3de1b9e46eb2b926554478e306dae18bb9a4' },
  'linux/x64': { name: `mnemon_${VERSION}_linux_amd64.tar.gz`, sha256: '443828b35fa7ecd083446dedf3574e271ad917c4f23e172b7bda6c09bfc0bb0f' },
  'linux/arm64': { name: `mnemon_${VERSION}_linux_arm64.tar.gz`, sha256: 'f9d60ff6fd11af65f8defbe8bd514a94cbd49496bfe13819a81f3156199fe49e' },
};

export function assetForPlatform(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}/${arch}`];
  if (!asset) throw new Error(`mnemon ${VERSION} 没有 ${platform}/${arch} 的发布包`);
  return { ...asset, url: `${BASE_URL}/${asset.name}` };
}

export async function verifySha256(file, expected) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex') === expected.toLowerCase();
}

const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };

async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
}

const extract = (archive, dir) => run('tar', ['-xzf', archive, '-C', dir, 'mnemon']);

async function versionOf(bin) {
  try { return (await run(bin, ['--version'], { timeout: 30_000 })).stdout; } catch { return ''; }
}

// 依赖（asset、download、extract、versionOf）可注入，离线测试用。返回 { action, path }。
export async function installMnemon({ stateDir, settings = {}, platform, arch, deps = {} }) {
  const { download: get = download, extract: unpack = extract, versionOf: version = versionOf } = deps;
  const configured = settings['memory.mnemonPath'];
  if (configured && executable(configured)) return { action: 'configured', path: configured };
  const target = join(stateDir, 'bin', 'mnemon');
  if (executable(target) && (await version(target)).includes(VERSION)) return { action: 'present', path: target };

  const asset = deps.asset ?? assetForPlatform(platform, arch);
  await mkdir(stateDir, { recursive: true });
  // 临时目录与目标同在状态目录下，rename 是原子的。
  const work = await mkdtemp(join(stateDir, '.setup-'));
  try {
    const archive = join(work, asset.name);
    await get(asset.url, archive);
    if (!await verifySha256(archive, asset.sha256)) throw new Error(`${asset.name} 的 SHA-256 与锁定值不符，已丢弃`);
    await unpack(archive, work);
    const bin = join(work, 'mnemon');
    await chmod(bin, 0o755);
    if (!(await version(bin)).includes(VERSION)) throw new Error(`解出的 mnemon 不是 ${VERSION}`);
    await mkdir(join(stateDir, 'bin'), { recursive: true });
    await rename(bin, target);
    return { action: 'installed', path: target };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const stateDir = process.env.CODA_PLUGIN_STATE;
  if (!stateDir) throw new Error('缺少 CODA_PLUGIN_STATE');
  const { action, path } = await installMnemon({ stateDir, settings: JSON.parse(process.env.CODA_PLUGIN_SETTINGS || '{}') });
  console.log(`mnemon ${VERSION}（${action}）${path}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
