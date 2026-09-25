const express = require('express');
const Site = require('../models/Site');
const User = require('../models/User');
const { protect, allow } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');
const { isValidCoord } = require('../utils/geo');

const router = express.Router();
router.use(protect, allow('contractor'));

function readSiteBody(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!isValidCoord(lat, lng)) throw httpError(400, 'Valid site location (lat, lng) is required');
  const radius = Number(body.radiusMeters) || 150;
  if (radius < 30 || radius > 2000) throw httpError(400, 'Radius must be between 30 and 2000 metres');
  return {
    name: body.name,
    address: body.address,
    clientName: body.clientName,
    lat,
    lng,
    radiusMeters: radius,
  };
}

// GET /api/sites
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const sites = await Site.find({ contractor: req.user._id }).sort({ active: -1, createdAt: -1 }).lean();
    const counts = await User.aggregate([
      { $match: { contractor: req.user._id, role: 'worker', status: 'active' } },
      { $group: { _id: '$assignedSite', count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
    res.json({ sites: sites.map((s) => ({ ...s, workerCount: countMap[String(s._id)] || 0 })) });
  })
);

// POST /api/sites
router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.body.name) throw httpError(400, 'Site name is required');
    const site = await Site.create({ ...readSiteBody(req.body), contractor: req.user._id });
    res.status(201).json({ site });
  })
);

// PATCH /api/sites/:id
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const site = await Site.findOne({ _id: req.params.id, contractor: req.user._id });
    if (!site) throw httpError(404, 'Site not found');
    const data = readSiteBody({ ...site.toObject(), ...req.body });
    Object.assign(site, data);
    if (req.body.active !== undefined) site.active = Boolean(req.body.active);
    await site.save();
    res.json({ site });
  })
);

module.exports = router;
