const express = require('express');
const User = require('../models/User');
const { asyncHandler } = require('../middleware/error');
const { readIdToken } = require('../utils/idToken');

const router = express.Router();

/**
 * GET /api/verify/:token  – PUBLIC (no login)
 * Anyone scanning the ID card QR (society guard, client) sees LIVE status.
 * Only non-sensitive details are returned.
 */
router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const data = readIdToken(req.params.token);
    if (!data) return res.status(404).json({ valid: false, status: 'invalid', message: 'This ID card is not genuine' });

    const worker = await User.findOne({ _id: data.workerId, role: 'worker' }).populate('contractor', 'companyName');
    if (!worker) return res.status(404).json({ valid: false, status: 'invalid', message: 'Worker not found' });

    let status = worker.status === 'active' ? 'active' : 'inactive';
    if (data.version !== worker.idVersion) status = 'replaced';
    else if (status === 'active' && worker.idValidTill && worker.idValidTill < new Date()) status = 'expired';

    const messages = {
      active: 'Verified worker',
      inactive: 'This worker is no longer working with this contractor',
      replaced: 'This is an old ID card. A newer card has been issued',
      expired: 'This ID card has expired',
    };

    res.json({
      valid: status === 'active',
      status,
      message: messages[status],
      worker: {
        name: worker.name,
        photoKey: worker.photoKey, // guard compares this live photo with the person's face
        workerCode: worker.workerCode,
        trade: worker.trade,
        level: worker.level,
        company: worker.contractor?.companyName,
        validTill: worker.idValidTill,
      },
    });
  })
);

module.exports = router;
