const crypto = require('crypto');

/**
 * ID card QR token = base64url(workerId.idVersion).signature
 * - The signature (HMAC-SHA256) stops anyone from guessing or forging other workers' links.
 * - idVersion lets the contractor re-issue a card; old QR codes then stop working.
 */
function secret() {
  return process.env.ID_CARD_SECRET || 'dev_id_secret';
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 22);
}

function createIdToken(worker) {
  const payload = Buffer.from(`${worker._id}.${worker.idVersion}`).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readIdToken(token = '') {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const [workerId, version] = Buffer.from(payload, 'base64url').toString().split('.');
  return { workerId, version: Number(version) };
}

module.exports = { createIdToken, readIdToken };
