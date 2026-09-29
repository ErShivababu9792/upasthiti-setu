/**
 * Public pages served by the backend (no website needed):
 *   GET /privacy – privacy policy (required by Google Play because the app uses location)
 */
const express = require('express');

const router = express.Router();

router.get('/privacy', (req, res) => {
  const contact = process.env.PRIVACY_CONTACT || 'the app owner (see the Upasthiti Setu GitHub page)';
  const updated = '29 September 2026';

  res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy – Upasthiti Setu</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;line-height:1.6;color:#1d2b2c;background:#f4f1ea}
  h1{color:#0f5257;margin-bottom:4px} h2{color:#0f5257;font-size:1.1rem;margin-top:28px}
  .card{background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
  small{color:#667676} li{margin:4px 0}
</style></head>
<body><div class="card">
<h1>Privacy Policy</h1>
<small>Upasthiti Setu · Last updated ${updated}</small>

<p>Upasthiti Setu helps contractors and workers keep fair records of attendance, wages and payments.
This page explains what data the app collects and why. In short: <b>we collect only what is needed for attendance and wages, and we never sell your data.</b></p>

<h2>What we collect</h2>
<ul>
  <li><b>Account details:</b> name, mobile number, password (stored encrypted), trade and skill answers, native place, emergency contact, blood group and UPI ID (optional).</li>
  <li><b>Location:</b> your GPS location <b>only at the moment you check in and check out</b>, to confirm you are at the work site. The app does <b>not</b> track your location at any other time or in the background.</li>
  <li><b>Photos:</b> a profile photo for your ID card and work-progress photos you choose to take at check-out.</li>
  <li><b>Work and money records:</b> attendance, hours, wages, advances, money requests and payment confirmations.</li>
</ul>

<h2>What we do NOT collect</h2>
<ul>
  <li>Full Aadhaar number, bank account number, contacts, messages or call logs.</li>
  <li>Background location or continuous tracking.</li>
</ul>

<h2>Who can see your data</h2>
<ul>
  <li><b>Your contractor</b> sees your attendance, photos, wages and payments for the time you work with them.</li>
  <li><b>Anyone who scans your ID card QR</b> sees only your name, photo, worker ID, trade, company and whether the card is valid.</li>
  <li>We do not sell or share your data with advertisers or other companies.</li>
</ul>

<h2>Why we use it</h2>
<p>To mark attendance, calculate wages and overtime, record payments, resolve disputes and verify worker ID cards.</p>

<h2>Consent</h2>
<p>The app asks for your permission before using location. You can turn off location permission any time in your phone settings, but then you cannot mark attendance yourself (your contractor can mark it manually).</p>

<h2>How long we keep data</h2>
<p>Records are kept while your account is active so that wage and payment history stays available to both sides. You can ask for your account to be deleted; payment records needed to settle dues may be kept until settled.</p>

<h2>Security</h2>
<p>Data is sent over HTTPS, passwords are encrypted (bcrypt), and ID card QR codes are digitally signed so they cannot be forged.</p>

<h2>Your rights (Digital Personal Data Protection Act, 2023)</h2>
<p>You can ask to see, correct or delete your personal data, or withdraw consent, by contacting ${contact}.</p>
</div></body></html>`);
});

module.exports = router;
