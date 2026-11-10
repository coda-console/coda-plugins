import { createHash } from 'node:crypto';
export const conversation = row => !row.entryKind || ['message', 'send-message'].includes(row.entryKind);
export const decode = row => {
  if (row.bodyOmitted) throw new Error('Grok transcript 正文被省略');
  return JSON.parse(Buffer.from(row.body, 'base64').toString());
};
export const cursor = (generation, seq) => `${generation}:${seq}`;
export const position = value => BigInt(value.split(':').at(-1));
export const signature = history => createHash('sha256').update(JSON.stringify(history)).digest('hex');
export async function history(client, bot) {
  const entries = [];
  let beforeSeq, generation;
  for (;;) {
    const page = await client.request('ListGrokBotTranscriptEntries', { agentId: bot, sessionId: '', limit: 1000,
      ...(beforeSeq ? { beforeSeq, generation } : {}) });
    if (generation !== undefined && generation !== (page.generation ?? 0)) throw new Error('Grok 历史分页期间已重置');
    generation = page.generation ?? 0;
    const rows = page.entries ?? [];
    entries.push(...rows);
    if (rows.length < 1000) return { generation, entries };
    const next = rows.reduce((n, row) => BigInt(row.seq) < BigInt(n) ? row.seq : n, rows[0].seq);
    if (beforeSeq && BigInt(next) >= BigInt(beforeSeq)) throw new Error('Grok 历史分页没有前进');
    beforeSeq = next;
  }
}
export function messages({ entries, generation }, self, bot) {
  const result = [];
  for (const row of entries) {
    if (!conversation(row)) continue;
    const body = decode(row), seq = String(row.updatedSeq ?? row.seq);
    const base = `${generation}:${row.entryId}`;
    let text, sender;
    if (body.kind === 'message' && body.role === 'user') { text = body.content ?? ''; sender = self; }
    else if (body.kind === 'send-message') {
      sender = bot;
      if (body.message?.type === 'text') text = body.message.content ?? '';
      else if (body.message?.type === 'widget') {
        const widget = body.message.widget;
        text = [widget.prompt || 'Grok 提问', ...widget.options.map(o => String(o.label ?? o.value))].join('\n');
      } else text = '请在 Grok 客户端查看此消息';
    } else continue; // Routine, activity and settlement are not conversation messages.
    if (body.message?.type === 'widget' && body.respondedValue !== undefined) {
      const option = body.message.widget.options.find(o => o.value === body.respondedValue);
      result.push({ id: `${base}:response:${seq}`, cursor: cursor(generation, seq), sender: self,
        text: String(option?.label ?? body.respondedValue), replyTo: base, mentions: [bot] });
    }
    const widget = body.message?.type === 'widget';
    const answered = widget && body.respondedValue !== undefined;
    const edited = !answered && seq !== String(row.seq);
    result.push({ id: edited ? `${base}:edit:${seq}` : base, cursor: cursor(generation, answered ? row.seq : seq), sender, text,
      ...(edited ? { about: { message: base, change: 'edit' } } : {}),
      ...(body.replyToId ? { replyTo: `${generation}:${body.replyToId}` } : {}),
      ...(body.timestampMs ? { createdAt: new Date(Number(body.timestampMs)).toISOString() } : {}) });
  }
  const senders = new Map(result.map(m => [m.id, m.sender]));
  for (const m of result) if (m.replyTo && senders.has(m.replyTo)) m.mentions = [senders.get(m.replyTo)];
  return result.sort((a, b) => position(a.cursor) < position(b.cursor) ? -1 : 1);
}
