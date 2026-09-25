const express = require('express');
const User = require('../models/User');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');
const MoneyRequest = require('../models/MoneyRequest');
const Payment = require('../models/Payment');
const { protect, allow } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');
const { todayIST } = require('../utils/dates');
const { closeForgottenCheckouts } = require('../utils/ledger');

const router = express.Router();
router.use(protect, allow('contractor'));

// GET /api/contractor/dashboard – numbers for the home screen
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const me = req.user._id;
    const today = todayIST();
    await closeForgottenCheckouts({ contractor: me }, today);

    const [pendingWorkers, activeWorkers, sites, todayRecords, flagged, openRequests, disputed] = await Promise.all([
      User.countDocuments({ contractor: me, role: 'worker', status: 'pending' }),
      User.countDocuments({ contractor: me, role: 'worker', status: 'active' }),
      Site.countDocuments({ contractor: me, active: true }),
      Attendance.find({ contractor: me, date: today }).select('status').lean(),
      Attendance.countDocuments({ contractor: me, status: 'flagged' }),
      MoneyRequest.countDocuments({ contractor: me, status: { $in: ['pending', 'approved'] } }),
      Payment.countDocuments({ contractor: me, status: 'disputed' }),
    ]);

    res.json({
      today,
      joinCode: req.user.joinCode,
      companyName: req.user.companyName,
      counts: {
        pendingWorkers,
        activeWorkers,
        sites,
        presentToday: todayRecords.length,
        onSiteNow: todayRecords.filter((r) => r.status === 'in_progress').length,
        absentToday: Math.max(0, activeWorkers - todayRecords.length),
        flagged,
        openRequests,
        disputed,
      },
    });
  })
);

// PATCH /api/contractor/settings – verification rules per contractor
router.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const limits = {
      minHoursFullDay: [1, 16],
      minHoursHalfDay: [0.5, 12],
      advanceLimit: [0, 100000],
      spotCheckNew: [0, 1],
      spotCheckTrusted: [0, 1],
      trustedAfterDays: [0, 365],
      idValidityMonths: [1, 60],
    };
    const settings = req.user.settings.toObject ? req.user.settings.toObject() : { ...req.user.settings };

    for (const [key, [min, max]] of Object.entries(limits)) {
      if (req.body[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (Number.isNaN(value) || value < min || value > max) {
        throw httpError(400, `${key} must be between ${min} and ${max}`);
      }
      settings[key] = value;
    }
    if (req.body.requireProgressPhoto !== undefined) {
      settings.requireProgressPhoto = Boolean(req.body.requireProgressPhoto);
    }
    if (settings.minHoursHalfDay >= settings.minHoursFullDay) {
      throw httpError(400, 'Half-day hours must be less than full-day hours');
    }

    req.user.settings = settings;
    await req.user.save();
    res.json({ settings: req.user.settings });
  })
);

module.exports = router;
