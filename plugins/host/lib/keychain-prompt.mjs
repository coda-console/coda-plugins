import { spawnSync } from 'node:child_process';

export const keychainPromptHint = '；此时屏幕上有钥匙串授权框（SecurityAgent）在等待应答，命令很可能卡在它上面；构建脚本不要读钥匙串，见 host-slots 说明';

export function keychainPromptSuffix() {
  return process.platform === 'darwin' && spawnSync('pgrep', ['-x', 'SecurityAgent'], { stdio: 'ignore' }).status === 0
    ? keychainPromptHint : '';
}
