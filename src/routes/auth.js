const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Photo = require('../models/Photo');
const { protect, signToken } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/error');
const { suggestLevel, DEFAULT_WAGE } = require('../utils/skill');
const { isProtectedDemoUser } = require('../utils/demo');

const router = express.Router();

const TRADES = ['carpenter', 'painter', 'electrician', 'plumber', 'mason', 'helper', 'other'];
const { LANGUAGES } = User;
const pickLanguage = (lang) => (LANGUAGES.includes(lang) ? lang : 'hi');

function cleanPhone(phone = '') {
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) throw httpError(400, 'Enter a valid 10-digit mobile number');
  return digits;
}

function checkPassword(password = '') {
  if (String(password).length < 6) throw httpError(400, 'Password must be at least 6 characters');
}

async function uniqueJoinCode() {
  // 6 characters, no confusing letters like O/0 or I/1
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 10; i++) {
    const code = Array.from(crypto.randomBytes(6), (b) => chars[b % chars.length]).join('');
    if (!(await User.exists({ joinCode: code }))) return code;
  }
  throw httpError(500, 'Could not create join code, try again');
}

// POST /api/auth/register/contractor
router.post(
  '/register/contractor',
  asyncHandler(async (req, res) => {
    const { name, phone, password, companyName, language } = req.body;
    if (!name || !companyName) throw httpError(400, 'Name and company name are required');
    checkPassword(password);

    const user = await User.create({
      role: 'contractor',
      name,
      phone: cleanPhone(phone),
      passwordHash: await bcrypt.hash(password, 10),
      companyName,
      language: pickLanguage(language || 'en'),
      joinCode: await uniqueJoinCode(),
    });

    res.status(201).json({ token: signToken(user), user: user.toSafeJSON() });
  })
);

// POST /api/auth/register/worker
router.post(
  '/register/worker',
  asyncHandler(async (req, res) => {
    const {
      name, phone, password, joinCode, trade, skill = {},
      nativePlace, emergencyContact = {}, bloodGroup, upiId, language,
    } = req.body;

    if (!name) throw httpError(400, 'Name is required');
    if (!TRADES.includes(trade)) throw httpError(400, 'Please choose your trade');
    checkPassword(password);

    const mobile = cleanPhone(phone);
    if (await User.exists({ phone: mobile })) {
      throw httpError(409, 'This mobile number is already registered. Please log in. To work with a new contractor, use "Join new contractor" after login');
    }

    const contractor = await User.findOne({
      role: 'contractor',
      joinCode: String(joinCode || '').trim().toUpperCase(),
    });
    if (!contractor) throw httpError(404, 'Contractor code not found. Ask your contractor for the correct code');

    const cleanSkill = {
      experienceYears: Math.max(0, Math.min(60, Number(skill.experienceYears) || 0)),
      tools: Array.isArray(skill.tools) ? skill.tools.slice(0, 20) : [],
      workTypes: Array.isArray(skill.workTypes) ? skill.workTypes.slice(0, 20) : [],
      canReadDrawings: Boolean(skill.canReadDrawings),
      canLeadTeam: Boolean(skill.canLeadTeam),
    };
    const level = suggestLevel(cleanSkill, trade);

    const user = await User.create({
      role: 'worker',
      name,
      phone: mobile,
      passwordHash: await bcrypt.hash(password, 10),
      language: pickLanguage(language),
      contractor: contractor._id,
      trade,
      skill: cleanSkill,
      suggestedLevel: level,
      level,
      dailyWage: DEFAULT_WAGE[level],
      status: 'pending',
      nativePlace,
      emergencyContact: {
        name: emergencyContact.name,
        phone: emergencyContact.phone ? String(emergencyContact.phone).replace(/\D/g, '').slice(-10) : undefined,
      },
      bloodGroup,
      upiId,
    });

    res.status(201).json({ token: signToken(user), user: user.toSafeJSON() });
  })
);

// POST /api/auth/login
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { phone, password } = req.body;
    const user = await User.findOne({ phone: cleanPhone(phone) }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash))) {
      throw httpError(401, 'Wrong mobile number or password');
    }
    res.json({ token: signToken(user), user: user.toSafeJSON() });
  })
);

// GET /api/auth/me
router.get(
  '/me',
  protect,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id)
      .populate('assignedSite', 'name address lat lng radiusMeters')
      .populate('contractor', 'name companyName phone');
    res.json({ user: user.toSafeJSON() });
  })
);

// PATCH /api/auth/me  (language, UPI, emergency contact, profile photo, location consent)
router.patch(
  '/me',
  protect,
  asyncHandler(async (req, res) => {
    const { language, upiId, emergencyContact, bloodGroup, photoKey, locationConsent } = req.body;

    if (photoKey !== undefined) {
      const photo = await Photo.findOne({ key: photoKey, owner: req.user._id, kind: 'profile' });
      if (!photo) throw httpError(400, 'Photo not found. Please upload again');
      if (req.user.photoKey && req.user.photoKey !== photoKey && req.user.role === 'worker') {
        req.user.idVersion += 1; // photo printed on the old ID card no longer matches → old QR shows "replaced"
      }
      req.user.photoKey = photoKey;
    }
    if (language) req.user.language = pickLanguage(language);
    if (upiId !== undefined) req.user.upiId = upiId;
    if (bloodGroup !== undefined) req.user.bloodGroup = bloodGroup;
    if (emergencyContact) req.user.emergencyContact = emergencyContact;
    if (locationConsent === true && !req.user.locationConsentAt) req.user.locationConsentAt = new Date();
    await req.user.save();
    res.json({ user: req.user.toSafeJSON() });
  })
);

// POST /api/auth/change-password  { oldPassword, newPassword }
// Logs out every other device (token version changes) and returns a fresh token for this one.
router.post(
  '/change-password',
  protect,
  asyncHandler(async (req, res) => {
    if (isProtectedDemoUser(req.user)) throw httpError(403, 'Demo accounts cannot change password');
    const { oldPassword, newPassword } = req.body;
    checkPassword(newPassword);

    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await bcrypt.compare(String(oldPassword || ''), user.passwordHash))) {
      throw httpError(400, 'Old password is wrong');
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    res.json({ token: signToken(user), message: 'Password changed. Other devices are logged out.' });
  })
);

// POST /api/auth/logout-all  – e.g. phone lost
router.post(
  '/logout-all',
  protect,
  asyncHandler(async (req, res) => {
    if (isProtectedDemoUser(req.user)) throw httpError(403, 'Not allowed for demo accounts');
    req.user.tokenVersion = (req.user.tokenVersion || 0) + 1;
    await req.user.save();
    res.json({ message: 'Logged out from all devices' });
  })
);

module.exports = router;
module.exports.cleanPhone = cleanPhone;
