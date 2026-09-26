const express = require('express');
const User = require('../models/User');
const { asyncHandler } = require('../middleware/error');
const { readIdToken } = require('../utils/idToken');

const router = express.Router();

const MESSAGES = {
  active: 'Verified worker',
  inactive: 'This worker is no longer working with this contractor',
  replaced: 'This is an old ID card. A newer card has been issued',
  expired: 'This ID card has expired',
  invalid: 'This ID card is not genuine',
};

/**
 * Reads the QR token and returns the LIVE status of the worker.
 * Only non-sensitive details are returned.
 */
async function checkIdCard(token) {
  const data = readIdToken(token);
  if (!data) return { valid: false, status: 'invalid', message: MESSAGES.invalid };

  const worker = await User.findOne({ _id: data.workerId, role: 'worker' }).populate('contractor', 'companyName');
  if (!worker) return { valid: false, status: 'invalid', message: 'Worker not found' };

  let status = worker.status === 'active' ? 'active' : 'inactive';
  if (data.version !== worker.idVersion) status = 'replaced';
  else if (status === 'active' && worker.idValidTill && worker.idValidTill < new Date()) status = 'expired';

  return {
    valid: status === 'active',
    status,
    message: MESSAGES[status],
    worker: {
      name: worker.name,
      photoKey: worker.photoKey, // guard compares this live photo with the person's face
      workerCode: worker.workerCode,
      trade: worker.trade,
      level: worker.level,
      company: worker.contractor?.companyName,
      validTill: worker.idValidTill,
    },
  };
}

/**
 * GET /api/verify/:token  – PUBLIC JSON (used by the app / website)
 */
router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const result = await checkIdCard(req.params.token);
    res.status(result.status === 'invalid' ? 404 : 200).json(result);
  })
);

// ---------------- HTML page for QR scans ----------------

const LEVELS = { helper: 'Helper', semi_skilled: 'Semi-skilled', skilled: 'Skilled', head_mistri: 'Head Mistri' };
const cap = (s = '') => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '–';

/**
 * GET /verify/:token  – PUBLIC web page opened when a guard / client scans the ID card QR.
 * Served by the backend itself, so it works even without a deployed website.
 * Rendered on the server: no JavaScript needed on the guard's phone.
 */
async function verifyPage(req, res) {
  const r = await checkIdCard(req.params.token);
  const ok = r.valid;
  const color = ok ? '#1f8a4c' : '#c0392b';
  const title = ok ? 'VERIFIED' : r.status === 'invalid' ? 'NOT GENUINE' : r.status.toUpperCase();
  const w = r.worker;
  const checkedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const photo = w?.photoKey
    ? `<img class="photo" src="/api/photos/${esc(w.photoKey)}" alt="Worker photo">`
    : '';
  const details = w
    ? `<dl>
        <dt>Name</dt><dd>${esc(w.name)}</dd>
        <dt>Worker ID</dt><dd>${esc(w.workerCode || '–')}</dd>
        <dt>Trade</dt><dd>${esc(cap(w.trade))} · ${esc(LEVELS[w.level] || '')}</dd>
        <dt>Works with</dt><dd>${esc(w.company || '–')}</dd>
        <dt>Valid till</dt><dd>${fmtDate(w.validTill)}</dd>
      </dl>`
    : '';

  res
    .status(r.status === 'invalid' ? 404 : 200)
    .set('Cache-Control', 'no-store') // always show the live status
    .type('html')
    .send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} – Upasthiti Setu</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1d2b2c;padding:16px;box-sizing:border-box}
  .card{background:#fff;max-width:400px;width:100%;border-radius:16px;padding:24px;text-align:center;border-top:6px solid ${color};box-shadow:0 4px 18px rgba(0,0,0,.08)}
  .icon{width:64px;height:64px;margin:0 auto 8px;border-radius:50%;background:${color};color:#fff;display:grid;place-items:center;font-size:34px}
  h1{color:${color};margin:4px 0;font-size:1.6rem}
  .photo{width:120px;height:140px;object-fit:cover;border-radius:12px;margin:12px auto 0;display:block;border:3px solid ${color}}
  dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;text-align:left;margin:16px 0}
  dt{color:#667676;font-size:.9rem}dd{margin:0;font-weight:600}
  small{color:#667676}
</style></head>
<body><div class="card">
  <div class="icon">${ok ? '&#10003;' : '&#10005;'}</div>
  <h1>${title}</h1>
  <p>${esc(r.message)}</p>
  ${photo}
  ${details}
  <small>Checked live on Upasthiti Setu · ${checkedAt}</small>
</div></body></html>`);
}

module.exports = router;
module.exports.verifyPage = asyncHandler(verifyPage);
