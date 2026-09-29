const express = require('express');
const MoneyRequest = require('../models/MoneyRequest');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { protect, allow, activeWorker } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');
const { workerLedger, contractorLedgers } = require('../utils/ledger');
const { todayIST, weekRange } = require('../utils/dates');

const router = express.Router();
router.use(protect);

function positiveAmount(value) {
  const amount = Math.round(Number(value));
  if (!(amount > 0)) throw httpError(400, 'Enter a valid amount');
  if (amount > 200000) throw httpError(400, 'Amount is too large');
  return amount;
}

// Worker sees records with their CURRENT contractor; contractor sees their own records
function scope(user) {
  return user.role === 'worker' ? { worker: user._id, contractor: user.contractor } : { contractor: user._id };
}

// =============== MONEY REQUESTS ===============

// POST /api/money/requests  (worker)  { amount, type, reason }
router.post(
  '/requests',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    const amount = positiveAmount(req.body.amount);
    const type = ['advance', 'wages', 'emergency'].includes(req.body.type) ? req.body.type : 'advance';
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (type === 'emergency' && reason.length < 3) throw httpError(400, 'Please write the reason for an emergency request');

    const contractor = await User.findById(req.user.contractor);
    const ledger = await workerLedger(req.user._id, contractor._id, { advanceLimit: contractor.settings.advanceLimit });

    if (ledger.hasOpenRequest) throw httpError(400, 'You already have a request waiting. Wait for it to be completed');
    if (amount > ledger.availableToRequest) {
      throw httpError(400, `You can request up to ₹${ledger.availableToRequest} right now`);
    }

    const request = await MoneyRequest.create({
      worker: req.user._id,
      contractor: req.user.contractor,
      amount,
      type,
      reason,
    });
    res.status(201).json({ request, message: 'Request sent to contractor' });
  })
);

// GET /api/money/requests?status=pending
router.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const filter = scope(req.user);
    if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };

    const requests = await MoneyRequest.find(filter)
      .populate('worker', 'name workerCode trade cleanDays')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Contractor sees earned balance next to each open request to decide quickly (2 queries for all)
    if (req.user.role === 'contractor') {
      const open = requests.filter((r) => ['pending', 'approved'].includes(r.status) && r.worker);
      const ledgers = await contractorLedgers(req.user._id, [...new Set(open.map((r) => String(r.worker._id)))], {
        advanceLimit: req.user.settings.advanceLimit,
      });
      for (const r of open) r.ledger = ledgers.get(String(r.worker._id));
    }
    res.json({ requests });
  })
);

// POST /api/money/requests/:id/decide  (contractor)  { decision: 'approve'|'decline', amount, note }
router.post(
  '/requests/:id/decide',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const request = await MoneyRequest.findOne({ _id: req.params.id, contractor: req.user._id });
    if (!request) throw httpError(404, 'Request not found');
    if (request.status !== 'pending') throw httpError(400, 'This request is already decided');

    if (req.body.decision === 'approve') {
      const amount = req.body.amount ? positiveAmount(req.body.amount) : request.amount;
      if (amount > request.amount) throw httpError(400, 'Approved amount cannot be more than requested');
      request.status = 'approved';
      request.approvedAmount = amount;
    } else if (req.body.decision === 'decline') {
      request.status = 'declined';
    } else {
      throw httpError(400, 'Decision must be approve or decline');
    }
    request.decisionNote = String(req.body.note || '').slice(0, 300);
    request.decidedAt = new Date();
    await request.save();
    res.json({ request });
  })
);

/**
 * POST /api/money/requests/:id/pay  (contractor)  { method, note }
 * Marks an approved request as paid → creates a payment the worker must confirm.
 *
 * Safety:
 *  1. Atomic claim (approved → paid): a double tap / two devices can't both pay
 *  2. Unique index on payment.request: a second safety net in the database
 *  3. If creating the payment fails, the claim is undone (paid → approved),
 *     so a request is never left "paid" without a payment record
 */
router.post(
  '/requests/:id/pay',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const request = await MoneyRequest.findOneAndUpdate(
      { _id: req.params.id, contractor: req.user._id, status: 'approved' },
      { $set: { status: 'paid' } },
      { returnDocument: 'after' }
    );
    if (!request) throw httpError(409, 'Request is not approved or is already paid');

    let payment;
    try {
      const ledger = await workerLedger(request.worker, req.user._id);
      payment = await Payment.create({
        worker: request.worker,
        contractor: req.user._id,
        amount: request.approvedAmount,
        kind: request.approvedAmount > Math.max(0, ledger.balance) ? 'advance' : 'wage',
        method: ['cash', 'upi', 'bank'].includes(req.body.method) ? req.body.method : 'cash',
        note: req.body.note || `Request: ${request.type}`,
        paidOn: todayIST(),
        request: request._id,
      });
    } catch (err) {
      if (err.code === 11000) throw httpError(409, 'Request is already paid'); // parallel call won – keep "paid"
      // Anything else: undo the claim so the contractor can try again
      await MoneyRequest.updateOne({ _id: request._id, status: 'paid', payment: { $exists: false } }, { $set: { status: 'approved' } });
      throw err;
    }
    request.payment = payment._id;
    await request.save();

    res.json({ request, payment });
  })
);

// =============== PAYMENTS ===============

// POST /api/money/payments  (contractor)  { workerId, amount, kind, method, note }
router.post(
  '/payments',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await User.findOne({ _id: req.body.workerId, role: 'worker', contractor: req.user._id });
    if (!worker) throw httpError(404, 'Worker not found');

    const payment = await Payment.create({
      worker: worker._id,
      contractor: req.user._id,
      amount: positiveAmount(req.body.amount),
      kind: req.body.kind === 'advance' ? 'advance' : 'wage',
      method: ['cash', 'upi', 'bank'].includes(req.body.method) ? req.body.method : 'cash',
      note: req.body.note,
      paidOn: todayIST(),
    });
    res.status(201).json({ payment, message: 'Payment saved. Worker will confirm it.' });
  })
);

// GET /api/money/payments?workerId=
router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const filter = scope(req.user);
    if (req.user.role === 'contractor' && req.query.workerId) filter.worker = req.query.workerId;
    if (req.query.status) filter.status = req.query.status;

    const payments = await Payment.find(filter)
      .populate('worker', 'name workerCode')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ payments });
  })
);

// POST /api/money/payments/:id/confirm  (worker) → "Received ✅"
router.post(
  '/payments/:id/confirm',
  allow('worker'),
  asyncHandler(async (req, res) => {
    const payment = await Payment.findOne({ _id: req.params.id, worker: req.user._id });
    if (!payment) throw httpError(404, 'Payment not found');
    if (payment.status === 'confirmed') throw httpError(400, 'Already confirmed');
    payment.status = 'confirmed';
    payment.confirmedAt = new Date();
    payment.disputeReason = undefined;
    await payment.save();
    res.json({ payment });
  })
);

// POST /api/money/payments/:id/dispute  (worker)  { reason }
router.post(
  '/payments/:id/dispute',
  allow('worker'),
  asyncHandler(async (req, res) => {
    const payment = await Payment.findOne({ _id: req.params.id, worker: req.user._id });
    if (!payment) throw httpError(404, 'Payment not found');
    if (payment.status !== 'pending_confirmation') throw httpError(400, 'Only unconfirmed payments can be disputed');
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) throw httpError(400, 'Please write what is wrong');
    payment.status = 'disputed';
    payment.disputeReason = reason.slice(0, 300);
    await payment.save();
    res.json({ payment });
  })
);

// DELETE /api/money/payments/:id  (contractor) – withdraw a wrong or disputed entry
router.delete(
  '/payments/:id',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const payment = await Payment.findOne({ _id: req.params.id, contractor: req.user._id });
    if (!payment) throw httpError(404, 'Payment not found');
    if (payment.status === 'confirmed') throw httpError(400, 'Confirmed payments cannot be deleted');
    await payment.deleteOne();
    if (payment.request) {
      await MoneyRequest.updateOne({ _id: payment.request }, { $set: { status: 'approved' }, $unset: { payment: 1 } });
    }
    res.json({ message: 'Payment removed' });
  })
);

// =============== WEEKLY SUMMARY (payday) ===============

// GET /api/money/weekly?date=YYYY-MM-DD  (contractor) – 3 queries in total, however many workers
router.get(
  '/weekly',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const range = weekRange(req.query.date || todayIST());
    const workers = await User.find({ role: 'worker', contractor: req.user._id, status: 'active' })
      .select('name workerCode trade dailyWage upiId')
      .lean();

    const ledgers = await contractorLedgers(req.user._id, workers.map((w) => w._id), range);
    const rows = workers.map((w) => ({ worker: w, ...ledgers.get(String(w._id)) }));
    const totals = {
      earnedThisWeek: rows.reduce((s, r) => s + r.period.earned, 0),
      balanceDue: rows.reduce((s, r) => s + Math.max(0, r.balance), 0),
      advancesOutstanding: rows.reduce((s, r) => s + r.advanceOutstanding, 0),
    };
    res.json({ range, rows, totals });
  })
);

module.exports = router;
