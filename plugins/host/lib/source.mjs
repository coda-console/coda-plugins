// All references and authenticated service locations are resolved by Coda. This module knows no machine IDs.
export class Sources {
  constructor(coda) { this.coda = coda; this.objects = new Map(); this.subscriptions = []; }
  async start() {
    for (const kind of ['gitSource', 'sourceSnapshot']) this.subscriptions.push(await this.coda.protocols.observe(kind, event => {
      const key = `${kind}/${event.id}`;
      if (event.type === 'DELETED') this.objects.delete(key); else this.objects.set(key, event.object);
    }));
  }
  async resolve(input) {
    if (!input) return null;
    const ref = input.snapshot ?? input.repository, object = this.objects.get(`${ref.kind}/${ref.id}`);
    if (!object?.status.ready || object.status.released) throw new Error('源码对象未就绪或快照已回收');
    const endpoint = await this.coda.protocols.resolve(ref, 'repository');
    let source = object, sourceEndpoint = endpoint;
    if (input.snapshot) {
      source = null;
      // PR #147's snapshot.source is holder-local. Match only within the same resolved service, never by ID alone.
      for (const candidate of this.objects.values()) if (candidate.kind === 'gitSource' && candidate.status.ready) {
        const resolved = await this.coda.protocols.resolve({ kind: candidate.kind, id: candidate.id }, 'repository');
        if (resolved.url === endpoint.url && resolved.resource.id === object.spec.source) { source = candidate; sourceEndpoint = resolved; break; }
      }
      if (!source) throw new Error('须发布快照所属 gitSource，才能确定来源工作副本身份');
    }
    const commit = input.snapshot ? object.status.commit : input.commit.toLowerCase();
    return { key: JSON.stringify([source.id, source.instance]), commit,
      ref: input.snapshot ? object.status.ref : commit,
      url: new URL(`repos/${encodeURIComponent(sourceEndpoint.resource.id)}`, sourceEndpoint.url).href,
      headers: sourceEndpoint.headers };
  }
  async stop() { for (const item of this.subscriptions) await item.dispose(); }
}
