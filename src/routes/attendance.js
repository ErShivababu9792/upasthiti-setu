const express = require('express');
const Attendance = require('../models/Attendance');
const Site = require('../models/Site');
const User = require('../models/User');
const Photo = require('../models/Photo');
const { protect, allow, activeWorker } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');
const { distanceMeters, isValidCoord } = require('../utils/geo');
const { todayIST } = require('../utils/dates');
const { closeForgottenCheckouts } = require('../utils/ledger');

const router = express.Router();
router.use(protect);

const MAX_GPS_ACCURACY = 100; // metres; worse readings are not trusted
const MAX_PHOTOS = 3; // progress photos per day

function readLocation(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!isValidCoord(lat, lng)) throw httpError(400, 'Location not received. Please turn on GPS and try again');
  return { lat, lng, accuracy: Number(body.accuracy) || null };
}

/**
 * Rule-based verification run at check-out.
 * Returns the status + day value. Contractor only reviews "flagged" days.
 */
function verifyDay({ hours, checkOutDistance, radius, photoCount = 0, workNote = '', accuracy, worker, settings, random = Math.random }) {
  const flags = [];

  if (checkOutDistance > radius) flags.push('checkout_outside_site');

  // Proof of work: attendance without progress → review
  const hasNote = String(workNote).trim().length >= 5;
  if (settings.requireProgressPhoto) {
    if (photoCount < 1) flags.push('no_progress_photo');
  } else if (photoCount < 1 && !hasNote) {
    flags.push('no_progress_note'); // a photo OR a written note is enough
  }

  if (accuracy && accuracy > MAX_GPS_ACCURACY) flags.push('weak_gps');
  if (accuracy && accuracy > MAX_GPS_ACCURACY) flags.push('weak_gps');
  if (hours < settings.minHoursHalfDay) flags.push('too_few_hours');

  // Random spot check: new workers are checked more often than trusted ones
  const trusted = worker.cleanDays >= settings.trustedAfterDays;
  const rate = trusted ? settings.spotCheckTrusted : settings.spotCheckNew;
  if (flags.length === 0 && random() < rate) flags.push('random_spot_check');

  if (flags.length) return { status: 'flagged', dayValue: 0, flags };
  if (hours >= settings.minHoursFullDay) return { status: 'auto_approved', dayValue: 1, flags };
  return { status: 'half_day', dayValue: 0.5, flags };
}

/**
 * Overtime = hours beyond `overtimeAfterHours`, paid at (daily wage ÷ 8) × multiplier per hour.
 * Saved on the record at check-out, so later rule changes don't rewrite old days.
 */
function overtimeFor(hours, wageRate, settings) {
  const after = settings.overtimeAfterHours ?? 9;
  const multiplier = settings.overtimeMultiplier ?? 1;
  const overtimeHours = Math.max(0, Math.round((hours - after) * 100) / 100);
  const overtimePay = Math.round(overtimeHours * (wageRate / 8) * multiplier);
  return { overtimeHours, overtimePay };
}

// ---------------- Worker ----------------

// GET /api/attendance/today – worker's status for today
router.get(
  '/today',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    const record = await Attendance.findOne({ worker: req.user._id, date: todayIST() }).populate('site', 'name');
    res.json({ record });
  })
);

// POST /api/attendance/check-in  { lat, lng, accuracy }   → "Hazri lagao"
router.post(
  '/check-in',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    const worker = req.user;
    // Privacy law (DPDP Act): location is used only after the worker agrees
    if (!worker.locationConsentAt) throw httpError(428, 'Please allow location use first');
    if (!worker.assignedSite) throw httpError(400, 'You are not assigned to any site yet. Contact your contractor');

    const site = await Site.findOne({ _id: worker.assignedSite, active: true });
    if (!site) throw httpError(400, 'Your site is not active. Contact your contractor');

    const loc = readLocation(req.body);
    const distance = distanceMeters(loc.lat, loc.lng, site.lat, site.lng);

    // Check-in is blocked outside the geofence (with a small allowance for GPS error)
    const allowance = Math.min(loc.accuracy || 0, 50);
    if (distance > site.radiusMeters + allowance) {
      throw httpError(
        400,
        `You are ${distance} m away from ${site.name}. Reach the site (within ${site.radiusMeters} m) to mark attendance`
      );
    }

    const date = todayIST();
    const existing = await Attendance.findOne({ worker: worker._id, date });
    if (existing) throw httpError(400, 'Attendance already marked for today');

    const record = await Attendance.create({
      worker: worker._id,
      contractor: worker.contractor,
      site: site._id,
      date,
      checkIn: { at: new Date(), ...loc, distance },
      wageRate: worker.dailyWage,
    });

    res.status(201).json({ record, message: `Hazri lag gayi ✅ ${site.name}` });
  })
);

// Accept only this worker's own progress photos, uploaded after today's check-in
async function validPhotoKeys(keys, workerId, since) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const unique = [...new Set(keys.map(String))].slice(0, MAX_PHOTOS);
  const photos = await Photo.find({
    key: { $in: unique },
    owner: workerId,
    kind: 'progress',
    createdAt: { $gte: since },
  }).select('key');
  return photos.map((p) => p.key);
}

// POST /api/attendance/check-out  { lat, lng, accuracy, workNote, photoKeys: [] }
router.post(
  '/check-out',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    const record = await Attendance.findOne({ worker: req.user._id, date: todayIST() });
    if (!record) throw httpError(400, 'You have not checked in today');
    if (record.status !== 'in_progress') throw httpError(400, 'You have already checked out today');

    const photos = await validPhotoKeys(req.body.photoKeys, req.user._id, record.checkIn.at);

    const site = await Site.findById(record.site);
    const contractor = await User.findById(req.user.contractor);
    const loc = readLocation(req.body);
    const distance = distanceMeters(loc.lat, loc.lng, site.lat, site.lng);
    const now = new Date();
    const hours = Math.round(((now - record.checkIn.at) / 36e5) * 100) / 100;

    const result = verifyDay({
      hours,
      checkOutDistance: distance,
      radius: site.radiusMeters + Math.min(loc.accuracy || 0, 50),
      photoCount: photos.length,
      workNote: req.body.workNote,
      accuracy: loc.accuracy,
      worker: req.user,
      settings: contractor.settings,
    });

    record.checkOut = { at: now, ...loc, distance };
    record.hours = hours;
    record.workNote = String(req.body.workNote || '').trim().slice(0, 500);
    record.photos = photos;
    Object.assign(record, overtimeFor(hours, record.wageRate, contractor.settings));
    record.status = result.status;
    record.dayValue = result.dayValue;
    record.flags = result.flags;
    await record.save();

    // Trust score: clean days build trust
    if (result.status === 'auto_approved') {
      await User.updateOne({ _id: req.user._id }, { $inc: { cleanDays: 1 } });
    }

    const messages = {
      auto_approved: 'Full day approved ✅',
      half_day: 'Half day recorded',
      flagged: 'Sent to contractor for review ⏳',
    };
    res.json({ record, message: messages[result.status] });
  })
);

// GET /api/attendance/mine?month=2026-09
router.get(
  '/mine',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    await closeForgottenCheckouts({ worker: req.user._id }, todayIST());
    const filter = { worker: req.user._id, contractor: req.user.contractor };
    if (/^\d{4}-\d{2}$/.test(req.query.month || '')) {
      filter.date = { $gte: `${req.query.month}-01`, $lte: `${req.query.month}-31` };
    }
    const records = await Attendance.find(filter).populate('site', 'name').sort({ date: -1 }).limit(62);
    res.json({ records });
  })
);

// POST /api/attendance/:id/correction  { message }  – worker explains a flagged day
router.post(
  '/:id/correction',
  allow('worker'),
  activeWorker,
  asyncHandler(async (req, res) => {
    const record = await Attendance.findOne({ _id: req.params.id, worker: req.user._id });
    if (!record) throw httpError(404, 'Attendance not found');
    if (!['flagged', 'rejected', 'half_day'].includes(record.status)) {
      throw httpError(400, 'Correction is only for flagged, rejected or half days');
    }
    const message = String(req.body.message || '').trim();
    if (message.length < 5) throw httpError(400, 'Please explain in a few words');
    record.correctionRequest = message.slice(0, 300);
    if (record.status !== 'flagged') {
      record.status = 'flagged';
      record.dayValue = 0;
    }
    record.flags = [...new Set([...record.flags, 'worker_correction'])];
    await record.save();
    res.json({ record, message: 'Sent to contractor' });
  })
);

// ---------------- Contractor ----------------

// GET /api/attendance?date=YYYY-MM-DD&status=flagged
router.get(
  '/',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    await closeForgottenCheckouts({ contractor: req.user._id }, todayIST());
    const filter = { contractor: req.user._id };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date) filter.date = req.query.date;
    else if (!req.query.status) filter.date = todayIST();

    const records = await Attendance.find(filter)
      .populate('worker', 'name workerCode trade level cleanDays phone photoKey')
      .populate('site', 'name')
      .sort({ date: -1, createdAt: -1 })
      .limit(200);
    res.json({ records });
  })
);

// POST /api/attendance/:id/review  { decision: 'approve'|'half_day'|'reject', note }
router.post(
  '/:id/review',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const record = await Attendance.findOne({ _id: req.params.id, contractor: req.user._id });
    if (!record) throw httpError(404, 'Attendance not found');
    if (record.status === 'in_progress') throw httpError(400, 'Worker has not checked out yet');

    const decisions = {
      approve: { status: 'approved', dayValue: 1 },
      half_day: { status: 'half_day', dayValue: 0.5 },
      reject: { status: 'rejected', dayValue: 0 },
    };
    const decision = decisions[req.body.decision];
    if (!decision) throw httpError(400, 'Decision must be approve, half_day or reject');

    Object.assign(record, decision, { reviewNote: req.body.note, reviewedAt: new Date() });
    await record.save();

    // Caught once → trust starts again from zero
    if (decision.status === 'rejected') {
      await User.updateOne({ _id: record.worker }, { $set: { cleanDays: 0 } });
    }

    res.json({ record });
  })
);

/**
 * POST /api/attendance/manual  (contractor / supervisor)
 * { workerId, date, hours, reason }
 * For days when the worker's phone was dead, GPS failed, or they have no smartphone.
 * Saved as approved but clearly marked "manual_entry" with a reason, so it is auditable.
 */
router.post(
  '/manual',
  allow('contractor'),
  asyncHandler(async (req, res) => {
    const worker = await User.findOne({ _id: req.body.workerId, role: 'worker', contractor: req.user._id, status: 'active' });
    if (!worker) throw httpError(404, 'Active worker not found');
    if (!worker.assignedSite) throw httpError(400, 'Assign a site to this worker first');

    const date = String(req.body.date || todayIST());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIST()) throw httpError(400, 'Choose a valid date (not in the future)');
    const hours = Number(req.body.hours);
    if (!(hours > 0 && hours <= 16)) throw httpError(400, 'Hours must be between 0 and 16');
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) throw httpError(400, 'Write a reason (e.g. phone not working)');

    const s = req.user.settings;
    const full = hours >= s.minHoursFullDay;
    const half = hours >= s.minHoursHalfDay;
    if (!half) throw httpError(400, `Less than ${s.minHoursHalfDay} hours is not counted`);

    try {
      const record = await Attendance.create({
        worker: worker._id,
        contractor: req.user._id,
        site: worker.assignedSite,
        date,
        hours,
        wageRate: worker.dailyWage,
        ...(full ? overtimeFor(hours, worker.dailyWage, s) : {}),
        status: full ? 'approved' : 'half_day',
        dayValue: full ? 1 : 0.5,
        manual: true,
        manualReason: reason.slice(0, 200),
        flags: ['manual_entry'],
        reviewedAt: new Date(),
      });
      res.status(201).json({ record, message: `Attendance saved for ${worker.name}` });
    } catch (err) {
      if (err.code === 11000) throw httpError(409, 'Attendance for this day already exists. Review it instead');
      throw err;
    }
  })
);

module.exports = router;
module.exports.verifyDay = verifyDay; // exported for tests
module.exports.overtimeFor = overtimeFor;
