import { createHash } from 'node:crypto';
export async function account(auth) {
  const me = await auth.client.request('GetMe', {}, { service: 'aiserver.v1.DashboardService' });
  const identity = me.userId || me.authId;
  if (!identity) throw new Error('Grok 未提供账号 ID');
  return { id: createHash('sha256').update(String(identity)).digest('hex'), title: me.name || me.email || 'Grok 账号' };
}
