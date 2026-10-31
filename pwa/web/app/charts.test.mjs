import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePoints, filterRange, summarize, renderChart } from './charts.js';

const date = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;

test('filters invalid values while retaining zero and stable coincident records', () => {
  const points = [{ id: 'later', at: date, value: 0 }, { id: 'first', at: date - DAY, value: 10 },
    { id: 'same', at: date, value: 12.5 }, { at: NaN, value: 2 }, { at: date, value: Infinity },
    { at: date, value: '12.5' }, null];
  const sorted = normalizePoints(points);
  assert.deepEqual(sorted.map(point => point.id), ['first', 'later', 'same']);
  assert.notEqual(sorted[0], points[1]);
  assert.equal(points[0].id, 'later');
});

test('date ranges include boundary and exclude future points', () => {
  const points = [{ at: date - 30 * DAY, value: 10 }, { at: date - 31 * DAY, value: 12 },
    { at: date, value: 13 }, { at: date + DAY, value: 14 }];
  assert.deepEqual(filterRange(points, 30, date).map(point => point.value), [10, 13]);
  assert.equal(filterRange(points, 'all', date).length, 4);
  assert.deepEqual(filterRange(points, -1, date), []);
});

test('summary computes changes chronologically and avoids division by zero', () => {
  assert.deepEqual(summarize([]), { first: null, last: null, change: 0, percent: null, count: 0 });
  assert.deepEqual(summarize([{ at: date + DAY, value: 12.5 }, { at: date, value: 10 }]),
    { first: 10, last: 12.5, change: 2.5, percent: 25, count: 2 });
  assert.equal(summarize([{ at: date, value: 0 }, { at: date + DAY, value: 3 }]).percent, null);
  assert.equal(summarize([{ at: date, value: 0.1 }, { at: date + DAY, value: 0.3 }]).change, 0.2);
});

test('single point renders as an actual centered point without invented line', () => {
  const html = renderChart([{ at: date, value: 72.5 }], { id: 'body', title: 'Peso corporal' });
  assert.match(html, /cx="228.5"/);
  assert.doesNotMatch(html, /class="chart-line"/);
  assert.match(html, /72,5/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('zero, constant and coincident datasets always render finite coordinates', () => {
  for (const points of [[{ at: date, value: 0 }], [{ at: date, value: 20 }, { at: date + DAY, value: 20 }],
    [{ at: date, value: 20 }, { at: date, value: 25 }]]) {
    const html = renderChart(points);
    assert.doesNotMatch(html, /NaN|Infinity/);
    assert.equal((html.match(/class="chart-point"/g) || []).length, points.length);
  }
});

test('empty charts do not invent observations and all supplied strings are escaped', () => {
  const html = renderChart([], { title: '<script>alert(1)</script>' });
  assert.match(html, /sem registros/);
  assert.doesNotMatch(html, /<script>|class="chart-point"/);
  const populated = renderChart([{ at: date, value: 20 }], { id: '"/><script>', title: '<img onerror=x>', unit: '<kg>' });
  assert.doesNotMatch(populated, /<script>|<img|<kg>/);
  assert.match(populated, /&lt;img onerror=x&gt;/);
});
