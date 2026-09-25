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

/**
 * Worker's money position.
 *   earned  = Σ (dayValue × wageRate) of counted days
 *   paid    = Σ payments that are pending or confirmed (disputed ones excluded)
 *   balance = earned − paid   (negative means the worker has taken an advance)
 */
async function workerLedger(workerId, { from, to, advanceLimit = 0 } = {}) {
  const [days, payments, openRequest] = await Promise.all([
    Attendance.find({ worker: workerId, dayValue: { $gt: 0 } }).lean(),
    Payment.find({ worker: workerId, status: { $ne: 'disputed' } }).lean(),
    MoneyRequest.findOne({ worker: workerId, status: { $in: ['pending', 'approved'] } }).lean(),
  ]);

  const earned = days.reduce((sum, d) => sum + d.dayValue * d.wageRate, 0);
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  const balance = earned - paid;

  const result = {
    totalDays: round(days.reduce((s, d) => s + d.dayValue, 0)),
    earned: round(earned),
    paid: round(paid),
    balance: round(balance),
    advanceOutstanding: round(Math.max(0, -balance)),
    availableToRequest: Math.max(0, Math.floor(balance + advanceLimit)),
    hasOpenRequest: Boolean(openRequest),
  };

  if (from && to) {
    const inRange = days.filter((d) => d.date >= from && d.date <= to);
    result.period = {
      from,
      to,
      days: round(inRange.reduce((s, d) => s + d.dayValue, 0)),
      earned: round(inRange.reduce((s, d) => s + d.dayValue * d.wageRate, 0)),
      paid: round(
        payments
          .filter((p) => p.paidOn && p.paidOn >= from && p.paidOn <= to)
          .reduce((s, p) => s + p.amount, 0)
      ),
    };
  }

  return result;
}

module.exports = { workerLedger, closeForgottenCheckouts };
