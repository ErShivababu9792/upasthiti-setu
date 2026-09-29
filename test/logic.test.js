/**
 * Unit tests for the core business rules (no database needed).
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const { suggestLevel } = require('../src/utils/skill');
const { distanceMeters } = require('../src/utils/geo');
const { weekRange, toISTDateString } = require('../src/utils/dates');
const { createIdToken, readIdToken } = require('../src/utils/idToken');
const { verifyDay } = require('../src/routes/attendance');

const settings = {
  minHoursFullDay: 7, minHoursHalfDay: 4, spotCheckNew: 0.3, spotCheckTrusted: 0.1, trustedAfterDays: 30,
};
const noRandom = () => 0.99; // never trigger spot check
const alwaysRandom = () => 0; // always trigger spot check

test('skill answers suggest the right level', () => {
  assert.strictEqual(suggestLevel({ experienceYears: 0 }, 'carpenter'), 'helper');
  assert.strictEqual(suggestLevel({ experienceYears: 3, tools: ['drill'] }, 'carpenter'), 'semi_skilled');
  assert.strictEqual(
    suggestLevel({ experienceYears: 8, tools: ['a', 'b'], workTypes: ['x', 'y'] }, 'carpenter'),
    'skilled'
  );
  assert.strictEqual(
    suggestLevel({ experienceYears: 12, tools: ['a', 'b', 'c'], workTypes: ['x', 'y'], canReadDrawings: true, canLeadTeam: true }, 'carpenter'),
    'head_mistri'
  );
  assert.strictEqual(suggestLevel({ experienceYears: 20, canLeadTeam: true }, 'helper'), 'helper');
});

test('haversine distance is accurate', () => {
  assert.strictEqual(distanceMeters(12.9716, 77.5946, 12.9716, 77.5946), 0);
  const d = distanceMeters(12.9716, 77.5946, 12.9725, 77.5946); // ~100 m north
  assert.ok(d > 95 && d < 105, `expected ~100 m, got ${d}`);
});

test('full clean day is auto-approved', () => {
  const r = verifyDay({ hours: 8.5, checkOutDistance: 20, radius: 150, photoCount: 2, worker: { cleanDays: 40 }, settings, random: noRandom });
  assert.deepStrictEqual(r, { status: 'auto_approved', dayValue: 1, flags: [] });
});

test('5 hours with proof becomes half day', () => {
  const r = verifyDay({ hours: 5, checkOutDistance: 20, radius: 150, photoCount: 1, worker: { cleanDays: 40 }, settings, random: noRandom });
  assert.strictEqual(r.status, 'half_day');
  assert.strictEqual(r.dayValue, 0.5);
});

test('attendance without any progress proof is flagged (fake attendance caught)', () => {
  const r = verifyDay({ hours: 9, checkOutDistance: 20, radius: 150, photoCount: 0, worker: { cleanDays: 40 }, settings, random: noRandom });
  assert.strictEqual(r.status, 'flagged');
  assert.ok(r.flags.includes('no_progress_note'));
});

test('a written note is enough proof when photos are optional', () => {
  const r = verifyDay({ hours: 9, checkOutDistance: 20, radius: 150, photoCount: 0, workNote: 'Fixed 4 shutters', worker: { cleanDays: 40 }, settings, random: noRandom });
  assert.strictEqual(r.status, 'auto_approved');
});

test('when contractor requires photos, a note alone is not enough', () => {
  const strict = { ...settings, requireProgressPhoto: true };
  const r = verifyDay({ hours: 9, checkOutDistance: 20, radius: 150, photoCount: 0, workNote: 'Fixed 4 shutters', worker: { cleanDays: 40 }, settings: strict, random: noRandom });
  assert.ok(r.flags.includes('no_progress_photo'));
});

test('checking out far from site is flagged', () => {
  const r = verifyDay({ hours: 9, checkOutDistance: 3000, radius: 150, photoCount: 1, worker: { cleanDays: 40 }, settings, random: noRandom });
  assert.ok(r.flags.includes('checkout_outside_site'));
});

test('random spot check flags even a clean day', () => {
  const r = verifyDay({ hours: 9, checkOutDistance: 20, radius: 150, photoCount: 1, worker: { cleanDays: 2 }, settings, random: alwaysRandom });
  assert.deepStrictEqual(r.flags, ['random_spot_check']);
});

test('week range is Monday to Sunday', () => {
  assert.deepStrictEqual(weekRange('2026-09-25'), { from: '2026-09-21', to: '2026-09-27' }); // Friday
  assert.deepStrictEqual(weekRange('2026-09-21'), { from: '2026-09-21', to: '2026-09-27' }); // Monday
  assert.deepStrictEqual(weekRange('2026-09-27'), { from: '2026-09-21', to: '2026-09-27' }); // Sunday
});

test('late-night time still counts as the same Indian date', () => {
  // 25 Sep 23:30 IST = 25 Sep 18:00 UTC
  assert.strictEqual(toISTDateString(new Date('2026-09-25T18:00:00Z')), '2026-09-25');
  // 26 Sep 00:30 IST = 25 Sep 19:00 UTC
  assert.strictEqual(toISTDateString(new Date('2026-09-25T19:00:00Z')), '2026-09-26');
});

test('ID card token cannot be forged and old versions are detectable', () => {
  const worker = { _id: '66f000000000000000000001', idVersion: 3 };
  const token = createIdToken(worker);
  assert.deepStrictEqual(readIdToken(token), { workerId: worker._id, version: 3 });

  const [payload] = token.split('.');
  assert.strictEqual(readIdToken(`${payload}.fakeSignature123456789`), null);
  assert.strictEqual(readIdToken('garbage'), null);
});

const { overtimeFor } = require('../src/routes/attendance');
const { buildLedger } = require('../src/utils/ledger');

test('overtime: only hours beyond the limit, paid per hour', () => {
  const s = { overtimeAfterHours: 9, overtimeMultiplier: 1 };
  assert.deepStrictEqual(overtimeFor(8, 800, s), { overtimeHours: 0, overtimePay: 0 });
  assert.deepStrictEqual(overtimeFor(11, 800, s), { overtimeHours: 2, overtimePay: 200 }); // 800/8 = 100 per hour
  assert.deepStrictEqual(overtimeFor(11, 800, { ...s, overtimeMultiplier: 1.5 }), { overtimeHours: 2, overtimePay: 300 });
});

test('ledger: overtime counts only on full days, disputed money is excluded upstream', () => {
  const days = [
    { date: '2026-09-21', dayValue: 1, wageRate: 1000, overtimePay: 250, overtimeHours: 2 },
    { date: '2026-09-22', dayValue: 0.5, wageRate: 1000, overtimePay: 999, overtimeHours: 9 }, // half day → no overtime
  ];
  const payments = [{ amount: 500, paidOn: '2026-09-22' }];
  const l = buildLedger(days, payments, { from: '2026-09-21', to: '2026-09-27', advanceLimit: 1000 });
  assert.strictEqual(l.earned, 1750); // 1000 + 250 + 500
  assert.strictEqual(l.balance, 1250);
  assert.strictEqual(l.overtimeHours, 2);
  assert.strictEqual(l.availableToRequest, 2250);
  assert.strictEqual(l.period.days, 1.5);
});
