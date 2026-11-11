import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';

test('simple resolves the named device through testbed before holding its group', async () => {
  const xml = readFileSync(new URL('../../../plugins/review/.coda/workflows/simple.bpmn', import.meta.url), 'utf8');
  const { root, problem } = await readWorkflow(xml, 'simple');
  assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const elements = process.flowElements.find(e => e.id === 'acceptance').flowElements;
  const resolve = elements.find(e => e.id === 'device-resolve');
  const lock = elements.find(e => e.id === 'device-lock');
  assert.equal(resolve.calledElement, 'resolve-testbed');
  assert.equal(resolve.extensionElements.values.find(v => v.name === 'device').value, '=inputs.device');
  assert.ok(elements.some(e => e.sourceRef === resolve && e.targetRef === lock));
  assert.equal(lock.extensionElements.values.find(v => v.name === 'group').value, '=device-resolve.group');
});
