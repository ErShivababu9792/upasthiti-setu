const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');
const { protect, allow, activeWorker } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');
const { LEVELS, DEFAULT_WAGE } = require('../utils/skill');
const { createIdToken } = require('../utils/idToken');
const { workerLedger, closeForgottenCheckouts } = require('../utils/ledger');
const { todayIST, weekRange } = require('../utils/dates');
const { isProtectedDemoUser } = require('../utils/demo');

const router = express.Router();
router.use(protect);

async function findMyWorker(contractorId, workerId) {
  const worker = await User.findOne({ _id: workerId, role: 'worker', contractor: contractorId });
  if (!worker) throw httpError(404, 'Worker not found');
  return worker;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

// Saves the current job into the worker's portable work history (only if they were approved)
async function closeCurrentJob(worker) {
  if (!worker.contractor || !worker.workerCode) return;
  const last = worker.pastJobs[worker.pastJobs.length - 1];
  if (last && String(last.contractor) === String(worker.contractor) && last.workerCode === worker.workerCode) return;
  const contractor = await User.findById(worker.contractor).select('companyName');
  worker.pastJobs.push({
    contractor: worker.contractor,
    companyName: contractor?.companyName,
    workerCode: worker.workerCode,
    trade: worker.trade,
    level: worker.level,
    from: worker.approvedAt,
    to: new Date(),
  });
}

// ---------------- Worker's own endpoints ----------------

// GET /api/workers/me/summary  – money + this week (with the current contractor)
router.get(
  '/me/summary',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    const contractor = await User.findById(req.user.contractor);
    await closeForgottenCheckouts({ worker: req.user._id }, todayIST());
    const ledger = await workerLedger(req.user._id, req.user.contractor, {
      ...weekRange(),
      advanceLimit: contractor.settings.advanceLimit,
    });
    res.json({
      ledger,
      dailyWage: req.user.dailyWage,
      level: req.user.level,
      overtimeRatePerHour: Math.round((req.user.dailyWage / 8) * contractor.settings.overtimeMultiplier),
    });
  })
);

// GET /api/workers/me/idcard – data needed to render the ID card + QR
router.get(
  '/me/idcard',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    const worker = await User.findById(req.user._id).populate('contractor', 'companyName name phone');
    const token = createIdToken(worker);
    const base = process.env.PUBLIC_VERIFY_BASE || 'http://localhost:5000/verify';
    res.json({
      card: {
        name: worker.name,
        photoKey: worker.photoKey,
        workerCode: worker.workerCode,
        trade: worker.trade,
        level: worker.level,
        company: worker.contractor.companyName,
        contractorName: worker.contractor.name,
        contractorPhone: worker.contractor.phone,
        emergencyContact: worker.emergencyContact,
        bloodGroup: worker.bloodGroup,
        validTill: worker.idValidTill,
        verifyUrl: `${base}/${token}`,
      },
    });
  })
);

// GET /api/workers/me/history – portable work history across contractors (proof of experience)
router.get(
  '/me/history',
  allow('worker'),
  asyncHandler(async (req, res) => {
    const days = await Attendance.find({ worker: req.user._id, dayValue: { $gt: 0 } }).select('contractor dayValue').lean();
    const daysByContractor = {};
    for (const d of days) daysByContractor[d.contractor] = (daysByContractor[d.contractor] || 0) + d.dayValue;

    const current = await User.findById(req.user.contractor).select('companyName');
    const jobs = req.user.pastJobs.map((j) => ({ ...j.toObject(), days: daysByContractor[j.contractor] || 0 }));
    if (req.user.status === 'active') {
      jobs.push({
        contractor: req.user.contractor,
        companyName: current?.companyName,
        workerCode: req.user.workerCode,
        trade: req.user.trade,
        level: req.user.level,
        from: req.user.approvedAt,
        to: null,
        current: true,
        days: daysByContractor[req.user.contractor] || 0,
      });
    }
    res.json({ jobs: jobs.reverse(), totalDays: days.reduce((s, d) => s + d.dayValue, 0) });
  })
);

// POST /api/workers/me/leave – stop working with the current contractor
router.post(
  '/me/leave',
  allow('worker'),
  asyncHandler(async (req, res) => {
    const w = req.user;
    if (!['active', 'pending'].includes(w.status)) throw httpError(400, 'You are not working with a contractor now');
    const open = await Attendance.exists({ worker: w._id, status: 'in_progress' });
    if (open) throw httpError(400, 'Check out from today\'s work first');

    await closeCurrentJob(w);
    w.status = 'inactive';
    w.assignedSite = undefined;
    w.idVersion += 1; // old ID card QR now shows "replaced"
    await w.save();
    res.json({ user: w.toSafeJSON(), message: 'You have left. Your old records stay safe. You can join a new contractor now.' });
  })
);

// POST /api/workers/me/join  { joinCode } – join a new contractor (after leaving / being removed / rejected)
router.post(
  '/me/join',
  allow('worker'),
  asyncHandler(async (req, res) => {
    const w = req.user;
    if (w.status === 'active') throw httpError(400, 'Leave your current contractor first');

    const contractor = await User.findOne({
      role: 'contractor',
      joinCode: String(req.body.joinCode || '').trim().toUpperCase(),
    });
    if (!contractor) throw httpError(404, 'Contractor code not found');
    if (String(contractor._id) === String(w.contractor) && w.status === 'pending') {
      throw httpError(400, 'You have already asked this contractor. Wait for approval');
    }

    await closeCurrentJob(w);
    w.contractor = contractor._id;
    w.status = 'pending';
    w.workerCode = undefined; // new contractor gives a new code on approval
    w.assignedSite = undefined;
    w.level = w.suggestedLevel || w.level;
    w.dailyWage = DEFAULT_WAGE[w.level] || w.dailyWage;
    w.cleanDays = 0; // trust is built again with the new contractor
    w.idVersion += 1;
    w.approvedAt = undefined;
    await w.save();
    res.json({ user: w.toSafeJSON(), message: `Request sent to ${contractor.companyName}` });
  })
);

// ---------------- Contractor endpoints ----------------

// GET /api/workers?status=pending
router.get(
  '/',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const filter = { role: 'worker', contractor: req.user._id };
    if (req.query.status) filter.status = req.query.status;
    const workers = await User.find(filter)
      .populate('assignedSite', 'name')
      .sort({ status: 1, createdAt: -1 });
    res.json({ workers: workers.map((w) => w.toSafeJSON()) });
  })
);

// GET /api/workers/:id  – profile + ledger with this contractor
router.get(
  '/:id',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await findMyWorker(req.user._id, req.params.id);
    await worker.populate('assignedSite', 'name');
    const ledger = await workerLedger(worker._id, req.user._id, {
      ...weekRange(),
      advanceLimit: req.user.settings.advanceLimit,
    });
    res.json({ worker: worker.toSafeJSON(), ledger });
  })
);

// POST /api/workers/:id/approve  { level, dailyWage, siteId }
router.post(
  '/:id/approve',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await findMyWorker(req.user._id, req.params.id);
    if (worker.status === 'active') throw httpError(400, 'Worker is already approved');

    const { level, dailyWage, siteId } = req.body;
    if (level && !LEVELS.includes(level)) throw httpError(400, 'Invalid level');
    const wage = Number(dailyWage ?? worker.dailyWage);
    if (!(wage > 0)) throw httpError(400, 'Daily wage must be more than 0');

    if (siteId) {
      const site = await Site.findOne({ _id: siteId, contractor: req.user._id });
      if (!site) throw httpError(404, 'Site not found');
      worker.assignedSite = site._id;
    }

    // Give worker code once, e.g. US-0007
    if (!worker.workerCode) {
      // Atomic $inc: two approvals at the same moment never get the same code
      const contractor = await User.collection.findOneAndUpdate(
        { _id: req.user._id },
        { $inc: { workerCounter: 1 } },
        { returnDocument: 'after', includeResultMetadata: false }
      );
      worker.workerCode = `US-${String(contractor.workerCounter).padStart(4, '0')}`;
    }

    worker.level = level || worker.level;
    worker.dailyWage = wage;
    worker.status = 'active';
    worker.approvedAt = new Date();
    worker.idValidTill = addMonths(new Date(), req.user.settings.idValidityMonths);
    await worker.save();

    res.json({ worker: worker.toSafeJSON(), message: 'Worker approved. ID card is ready.' });
  })
);

// POST /api/workers/:id/reject
router.post(
  '/:id/reject',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await findMyWorker(req.user._id, req.params.id);
    if (worker.status !== 'pending') throw httpError(400, 'Only pending workers can be rejected');
    worker.status = 'rejected';
    await worker.save();
    res.json({ worker: worker.toSafeJSON() });
  })
);

// PATCH /api/workers/:id  { level, dailyWage, siteId, status: 'active'|'inactive' }
router.patch(
  '/:id',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await findMyWorker(req.user._id, req.params.id);
    const { level, dailyWage, siteId, status } = req.body;

    if (level && level !== worker.level) {
      if (!LEVELS.includes(level)) throw httpError(400, 'Invalid level');
      worker.level = level;
      worker.idVersion += 1; // level printed on card changed → old card QR becomes invalid
    }
    if (dailyWage !== undefined) {
      if (!(Number(dailyWage) > 0)) throw httpError(400, 'Daily wage must be more than 0');
      worker.dailyWage = Number(dailyWage); // applies from next check-in, old days keep old rate
    }
    if (siteId !== undefined) {
      if (siteId) {
        const site = await Site.findOne({ _id: siteId, contractor: req.user._id });
        if (!site) throw httpError(404, 'Site not found');
        worker.assignedSite = site._id;
      } else {
        worker.assignedSite = undefined;
      }
    }
    if (status) {
      if (!['active', 'inactive'].includes(status)) throw httpError(400, 'Invalid status');
      if (worker.status === 'pending' || worker.status === 'rejected') {
        throw httpError(400, 'Approve the worker first');
      }
      if (status === 'active' && worker.status === 'inactive') {
        worker.idValidTill = addMonths(new Date(), req.user.settings.idValidityMonths);
      }
      worker.status = status; // inactive → QR verify page shows "Inactive" instantly
    }

    await worker.save();
    await worker.populate('assignedSite', 'name');
    res.json({ worker: worker.toSafeJSON() });
  })
);

// POST /api/workers/:id/reissue-id  – invalidates old QR codes
router.post(
  '/:id/reissue-id',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await findMyWorker(req.user._id, req.params.id);
    if (worker.status !== 'active') throw httpError(400, 'Only active workers get an ID card');
    worker.idVersion += 1;
    worker.idValidTill = addMonths(new Date(), req.user.settings.idValidityMonths);
    await worker.save();
    res.json({ message: 'New ID card issued. Old QR code no longer works.' });
  })
);

// POST /api/workers/:id/reset-password – worker forgot password; contractor gives a temporary one
router.post(
  '/:id/reset-password',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await findMyWorker(req.user._id, req.params.id);
    if (isProtectedDemoUser(worker)) throw httpError(403, 'Demo accounts cannot be reset');

    const tempPassword = String(crypto.randomInt(100000, 1000000)); // 6 digits, easy to tell on phone
    await User.updateOne(
      { _id: worker._id },
      { $set: { passwordHash: await bcrypt.hash(tempPassword, 10) }, $inc: { tokenVersion: 1 } }
    );
    res.json({
      tempPassword,
      message: `Tell ${worker.name} this password. They should change it after logging in.`,
    });
  })
);

module.exports = router;
