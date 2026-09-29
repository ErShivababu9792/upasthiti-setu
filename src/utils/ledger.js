const Attendance = require('../models/Attendance');
const Payment = require('../models/Payment');
const MoneyRequest = require('../models/MoneyRequest');

const round = (n) => Math.round(n * 100) / 100;

/**
 * Days left "in_progress" from earlier dates mean the worker never checked out.
 * They are moved to the review list instead of being silently lost.
 */
async function closeForgottenCheckouts(filter, today) {
  await Attendance.updateMany(
    { ...filter, status: 'in_progress', date: { $lt: today } },
    { $set: { status: 'flagged', dayValue: 0 }, $addToSet: { flags: 'no_checkout' } }
  );
}

// Money earned for one attendance record
function dayMoney(d) {
  const overtime = d.dayValue === 1 ? d.overtimePay || 0 : 0;
  return d.dayValue * d.wageRate + overtime;
}

/**
 * Builds the money position from already-loaded records.
 *   earned  = Σ money of counted days (wage + overtime)
 *   paid    = Σ payments that are pending or confirmed (disputed ones excluded)
 *   balance = earned − paid   (negative means the worker has taken an advance)
 */
function buildLedger(days, payments, { from, to, advanceLimit = 0, hasOpenRequest = false } = {}) {
  const earned = days.reduce((sum, d) => sum + dayMoney(d), 0);
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  const balance = earned - paid;

  const result = {
    totalDays: round(days.reduce((s, d) => s + d.dayValue, 0)),
    overtimeHours: round(days.reduce((s, d) => s + (d.dayValue === 1 ? d.overtimeHours || 0 : 0), 0)),
    earned: round(earned),
    paid: round(paid),
    balance: round(balance),
    advanceOutstanding: round(Math.max(0, -balance)),
    availableToRequest: Math.max(0, Math.floor(balance + advanceLimit)),
    hasOpenRequest,
  };

  if (from && to) {
    const inRange = days.filter((d) => d.date >= from && d.date <= to);
    result.period = {
      from,
      to,
      days: round(inRange.reduce((s, d) => s + d.dayValue, 0)),
      overtimeHours: round(inRange.reduce((s, d) => s + (d.dayValue === 1 ? d.overtimeHours || 0 : 0), 0)),
      earned: round(inRange.reduce((s, d) => s + dayMoney(d), 0)),
      paid: round(
        payments.filter((p) => p.paidOn && p.paidOn >= from && p.paidOn <= to).reduce((s, p) => s + p.amount, 0)
      ),
    };
  }
  return result;
}

const DAY_FIELDS = 'worker date dayValue wageRate overtimePay overtimeHours';
const PAY_FIELDS = 'worker amount paidOn';

/**
 * One worker's money position WITH ONE CONTRACTOR.
 * (A worker who changed contractor has a separate account with each.)
 */
async function workerLedger(workerId, contractorId, { from, to, advanceLimit = 0 } = {}) {
  const [days, payments, openRequest] = await Promise.all([
    Attendance.find({ worker: workerId, contractor: contractorId, dayValue: { $gt: 0 } }).select(DAY_FIELDS).lean(),
    Payment.find({ worker: workerId, contractor: contractorId, status: { $ne: 'disputed' } }).select(PAY_FIELDS).lean(),
    MoneyRequest.exists({ worker: workerId, contractor: contractorId, status: { $in: ['pending', 'approved'] } }),
  ]);
  return buildLedger(days, payments, { from, to, advanceLimit, hasOpenRequest: Boolean(openRequest) });
}

/**
 * Ledgers for MANY workers of one contractor with just 2 queries
 * (instead of 2 queries per worker – the "N+1 problem").
 * Returns a Map: workerId → ledger
 */
async function contractorLedgers(contractorId, workerIds, { from, to, advanceLimit = 0 } = {}) {
  const [days, payments] = await Promise.all([
    Attendance.find({ contractor: contractorId, worker: { $in: workerIds }, dayValue: { $gt: 0 } })
      .select(DAY_FIELDS)
      .lean(),
    Payment.find({ contractor: contractorId, worker: { $in: workerIds }, status: { $ne: 'disputed' } })
      .select(PAY_FIELDS)
      .lean(),
  ]);

  const group = (list) => {
    const map = new Map();
    for (const item of list) {
      const key = String(item.worker);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  };
  const daysBy = group(days);
  const paysBy = group(payments);

  const result = new Map();
  for (const id of workerIds) {
    const key = String(id);
    result.set(key, buildLedger(daysBy.get(key) || [], paysBy.get(key) || [], { from, to, advanceLimit }));
  }
  return result;
}

module.exports = { workerLedger, contractorLedgers, buildLedger, dayMoney, closeForgottenCheckouts };
