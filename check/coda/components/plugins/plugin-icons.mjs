// How a plugin's icons are read and shown (docs/plugins.md「插件页」): its own, and those of what it brings drawn the same way
// (an agent's, components/session-config/contributions.mjs).
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

// An icon file, read once with the plugin (its schema says it is a PDF in the plugin's directory): both clients draw it as
// they drew the brand artwork they shipped with.
const icon = (dir, path) => readFileSync(join(dir, normalize(path))).toString('base64');
// The PDFs an icon names (an agent's, or a plugin's own drawn the same way), read: light, dark when there is one, and
// whether it is drawn in the text colour.
export const iconFiles = (dir, spec) => ({ light: icon(dir, spec.light), ...(spec.dark !== undefined ? { dark: icon(dir, spec.dark) } : {}), template: spec.template === true });
// An icon as the clients are given it: PDFs as data, light and dark, and whether they take the text's color; a symbol on
// a colour as it is.
const pdf = data => data ? `data:application/pdf;base64,${data}` : null;
export const shownIcon = icon => icon.symbol ? { symbol: icon.symbol, color: icon.color } : { light: pdf(icon.light), dark: pdf(icon.dark), template: icon.template };
