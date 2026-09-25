const express = require('express');
const crypto = require('crypto');
const Photo = require('../models/Photo');
const { protect } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');

const router = express.Router();

const MAX_BYTES = 600 * 1024; // phone compresses to ~100 KB; this is a safety limit
const TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP',
};

/**
 * POST /api/photos  { data: "data:image/jpeg;base64,...", kind: "profile" | "progress" }
 * Returns { key } – send this key with check-out or profile update.
 */
router.post(
  '/',
  protect,
  asyncHandler(async (req, res) => {
    const { data, kind } = req.body;
    if (!['profile', 'progress'].includes(kind)) throw httpError(400, 'Invalid photo type');
    if (kind === 'progress' && req.user.role !== 'worker') throw httpError(403, 'Only workers upload progress photos');
    if (kind === 'progress' && req.user.status !== 'active') throw httpError(403, 'Your profile is not approved yet');

    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(data || ''));
    if (!match) throw httpError(400, 'Photo must be a JPEG, PNG or WEBP image');

    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_BYTES) throw httpError(413, 'Photo is too large');
    // Check the real file bytes, not just what the client claims
    if (!TYPES[match[1]](buffer)) throw httpError(400, 'File is not a valid image');

    // Limit abuse: max 20 progress photos per worker per day
    if (kind === 'progress') {
      const since = new Date(Date.now() - 24 * 36e5);
      const count = await Photo.countDocuments({ owner: req.user._id, kind, createdAt: { $gte: since } });
      if (count >= 20) throw httpError(429, 'Too many photos today');
    }

    const photo = await Photo.create({
      key: crypto.randomBytes(12).toString('hex'),
      owner: req.user._id,
      contractor: req.user.role === 'worker' ? req.user.contractor : req.user._id,
      kind,
      mime: match[1],
      size: buffer.length,
      data: buffer,
    });

    res.status(201).json({ key: photo.key, size: photo.size });
  })
);

// GET /api/photos/:key  – image bytes (public URL, but the key is random and unguessable)
router.get(
  '/:key',
  asyncHandler(async (req, res) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.key)) return res.status(404).end();
    const photo = await Photo.findOne({ key: req.params.key }).select('+data mime');
    if (!photo) return res.status(404).end();
    res.set('Content-Type', photo.mime);
    res.set('Cache-Control', 'private, max-age=86400, immutable');
    res.send(photo.data);
  })
);

module.exports = router;
