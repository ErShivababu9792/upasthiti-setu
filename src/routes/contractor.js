const express = require('express');
const User = require('../models/User');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');
const MoneyRequest = require('../models/MoneyRequest');
const Payment = require('../models/Payment');
const { protect, allow } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');
const { todayIST } = require('../utils/dates');
const { closeForgottenCheckouts, contractorLedgers, dayMoney } = require('../utils/ledger');

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

// PATCH /api/contractor/settings – verification, advance and overtime rules
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
      overtimeAfterHours: [4, 16],
      overtimeMultiplier: [1, 3],
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
    if (settings.overtimeAfterHours < settings.minHoursFullDay) {
      throw httpError(400, 'Overtime must start after the full-day hours');
    }

    req.user.settings = settings;
    await req.user.save();
    res.json({ settings: req.user.settings });
  })
);

// ---------------- Monthly report (CSV → opens in Excel / Google Sheets) ----------------

// Quote a value for CSV: commas, quotes and new lines must not break the columns
const cell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'); // BOM = Excel shows ₹ and Hindi names correctly

/**
 * GET /api/contractor/report?month=2026-09&type=summary|attendance
 *  summary    – one row per worker: days, overtime, earned, paid this month, balance
 *  attendance – one row per worker per day
 */
router.get(
  '/report',
  asyncHandler(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayIST().slice(0, 7);
    const from = `${month}-01`;
    const to = `${month}-31`;
    const type = req.query.type === 'attendance' ? 'attendance' : 'summary';
    const me = req.user._id;

    let rows;
    if (type === 'attendance') {
      const records = await Attendance.find({ contractor: me, date: { $gte: from, $lte: to } })
        .populate('worker', 'name workerCode')
        .populate('site', 'name')
        .sort({ date: 1 })
        .lean();
      const time = (d) =>
        d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
      rows = [
        ['Date', 'Worker', 'Worker ID', 'Site', 'Check-in', 'Check-out', 'Hours', 'Status', 'Day value', 'Daily wage', 'Overtime hours', 'Overtime pay', 'Amount', 'Work note', 'Manual reason'],
        ...records.map((r) => [
          r.date, r.worker?.name, r.worker?.workerCode, r.site?.name, time(r.checkIn?.at), time(r.checkOut?.at),
          r.hours, r.status, r.dayValue, r.wageRate, r.dayValue === 1 ? r.overtimeHours || 0 : 0,
          r.dayValue === 1 ? r.overtimePay || 0 : 0, dayMoney(r), r.workNote, r.manualReason,
        ]),
      ];
    } else {
      // Everyone who worked this month, even if removed since
      const ids = await Attendance.distinct('worker', { contractor: me, date: { $gte: from, $lte: to } });
      const active = await User.find({ contractor: me, role: 'worker', status: 'active' }).select('_id').lean();
      const allIds = [...new Set([...ids.map(String), ...active.map((w) => String(w._id))])];
      const workers = await User.find({ _id: { $in: allIds } }).select('name workerCode trade dailyWage upiId').lean();
      const ledgers = await contractorLedgers(me, allIds, { from, to });

      rows = [
        ['Worker', 'Worker ID', 'Trade', 'Daily wage', `Days (${month})`, 'Overtime hours', 'Earned this month', 'Paid this month', 'Total balance due', 'Advance outstanding', 'UPI ID'],
        ...workers.map((w) => {
          const l = ledgers.get(String(w._id));
          return [
            w.name, w.workerCode, w.trade, w.dailyWage, l.period.days, l.period.overtimeHours, l.period.earned,
            l.period.paid, Math.max(0, l.balance), l.advanceOutstanding, w.upiId,
          ];
        }),
      ];
    }

    const safeName = (req.user.companyName || 'report').replace(/[^a-z0-9]+/gi, '-');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${safeName}-${type}-${month}.csv"`);
    res.send(toCsv(rows));
  })
);

module.exports = router;
