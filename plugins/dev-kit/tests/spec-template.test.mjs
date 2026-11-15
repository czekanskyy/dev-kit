import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const SECTIONS = ['Goal', 'Acceptance criteria', 'Data model', 'Tasks', 'Decisions', 'Risks'];

describe('templates/spec.md', () => {
  const template = read('templates/spec.md');
  const body = template.replace(/<!--[\s\S]*?-->/g, '');

  test('has the required sections in order', () => {
    const found = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(found, SECTIONS);
  });

  test('keeps the tier and status line, the task table header and the decision statuses', () => {
    assert.match(body, /^Tier: T2 \| T3\. Status: /m);
    assert.match(body, /\| # \| Task \| Tier \| Files \| Tests \| Depends on \|/);
    assert.match(body, /\| # \| Question \| Status \| Choice or options \| Recommendation \|/);
    for (const status of ['Decided', 'Assumed', 'Needs decision']) assert.ok(body.includes(status), status);
    assert.match(body, /^Parallelism: /m);
  });

  test('carries no project data', () => {
    assert.doesNotMatch(template, /body-work|bodywork|payload|coolify/i);
  });
});

describe('planner agent and plan-feature', () => {
  test('the planner reads the template instead of an inline outline', () => {
    const planner = read('agents/planner.md');
    assert.match(planner, /templates\/spec\.md/);
    assert.doesNotMatch(planner, /```markdown/);
  });

  test('plan-feature checks the result against the template', () => {
    assert.match(read('skills/plan-feature/SKILL.md'), /templates\/spec\.md/);
  });
});
