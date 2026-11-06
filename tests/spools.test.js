import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetApp } from './helpers/reset.js';
import { HISTORY_KEY } from '../printpricer/js/state.js';
import { forecastSpoolDays } from '../printpricer/js/spools.js';

const DAY = 86400000;
// History entries use their creation timestamp as the id.
function setHistory(entries) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
}
const used = (daysAgo, spoolId, grams) => ({
  id: Date.now() - daysAgo * DAY,
  filaments: [{ spoolId, grams: String(grams) }],
});

beforeEach(resetApp);

describe('forecastSpoolDays', () => {
  const spool = { id: 's1', remainingGrams: 500 };

  it('returns null with no history', () => {
    assert.equal(forecastSpoolDays(spool), null);
  });

  it('returns null for an empty spool', () => {
    setHistory([used(1, 's1', 100)]);
    assert.equal(forecastSpoolDays({ id: 's1', remainingGrams: 0 }), null);
  });

  it('projects days left from the last 30 days of use', () => {
    // 100 g over 10 days = 10 g/day; 500 g left = 50 days.
    setHistory([used(10, 's1', 60), used(2, 's1', 40)]);
    assert.equal(forecastSpoolDays(spool), '· ~50d at current use');
  });

  it('measures the span from the oldest print of any spool', () => {
    // The other spool's print 20 days ago stretches the window: 100 g / 20 d = 5 g/day.
    setHistory([used(20, 'other', 10), used(5, 's1', 100)]);
    assert.equal(forecastSpoolDays(spool), '· ~100d at current use');
  });

  it('treats a span under one day as one day', () => {
    setHistory([used(0, 's1', 250)]);
    assert.equal(forecastSpoolDays(spool), '· ~2d at current use');
  });

  it('ignores prints older than 30 days', () => {
    setHistory([used(45, 's1', 1000)]);
    assert.equal(forecastSpoolDays(spool), null);
  });

  it('says it runs out today when less than half a day is left', () => {
    setHistory([used(0, 's1', 1000)]);
    assert.equal(forecastSpoolDays({ id: 's1', remainingGrams: 100 }), '· runs out today');
  });

  it('returns null for under 1 g of use or a negligible rate', () => {
    setHistory([used(1, 's1', 0.5)]);
    assert.equal(forecastSpoolDays(spool), null);
    setHistory([used(29, 's1', 2)]); // 0.07 g/day
    assert.equal(forecastSpoolDays(spool), null);
  });

  it('returns null when it would last a year or more', () => {
    setHistory([used(29, 's1', 29)]); // 1 g/day
    assert.equal(forecastSpoolDays({ id: 's1', remainingGrams: 400 }), null);
  });

  it('skips entries without filaments and non-numeric grams', () => {
    setHistory([{ id: Date.now() - 10 * DAY }, { id: Date.now() - DAY, filaments: [{ spoolId: 's1', grams: 'n/a' }, { spoolId: 's1', grams: '100' }] }]);
    assert.equal(forecastSpoolDays(spool), '· ~50d at current use');
  });

  it('does not throw on corrupt history JSON', () => {
    localStorage.setItem(HISTORY_KEY, '[{bad');
    assert.equal(forecastSpoolDays(spool), null);
  });
});
