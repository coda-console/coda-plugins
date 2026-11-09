// The keys of `contributes` Coda's own components take (docs/plugins.md「插件对外贡献」), as VS Code's contribution points:
// each a point the component that reads it registers, saying what a plugin may write under it (`schema`, a JSON Schema
// checked in the whole manifest, @coda-console/protocol's contributionProblem), what a plugin's value of it is on the plugin (`read`, given
// the value written, none when it writes none), what of it only one plugin may declare (`claim`, of the plugin read), and
// what installing it confirms of it (`confirm`), how a plugin drawing no icon of its own is drawn (`icon`, of the plugin
// read, none when it says nothing), why one from elsewhere than Coda's own may not bring what it does (`builtinOnly`,
// of the plugin read, none when it may), and the formats of a setting's value it defines (`formats`, by the name a
// declaration writes: `(value, where, code)` checks one and returns it normalised, components/plugins/plugin-rules.mjs
// checkValue). The plugins' base knows none of the keys, nor those formats: it asks the point a key or a format names.
// A component defines its points as its module loads (components/workflows/contributions.mjs); what puts Coda together
// loads those before any plugin is read (application/contributions.mjs), as the wait kinds are (kernel/wait-kinds.mjs).
export class ContributionPoints {
  constructor(points = []) {
    this.points = new Map();
    for (const point of points) this.register(point);
  }
  register(point) {
    if (this.points.has(point.key)) throw new Error(`contributes.${point.key} 登记了两次`);
    this.points.set(point.key, point);
  }
  get(key) { return this.points.get(key) ?? null; }
  values() { return this.points.values(); }
}

// Coda's: the one table the components define their points in.
export const CONTRIBUTION_POINTS = new ContributionPoints();
export const defineContributionPoint = point => CONTRIBUTION_POINTS.register(point);
