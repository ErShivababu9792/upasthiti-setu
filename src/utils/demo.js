/**
 * Demo data + protection for the public live demo.
 *
 * Demo logins (password demo123):
 *   Contractor 9000000001 (join code SHIVA1)
 *   Workers    9000000002 Ravi (active), 9000000003 Suresh (active), 9000000004 Imran (pending)
 *
 * When DEMO_MODE=true (set on Render):
 *   - demo data is rebuilt automatically once a day (first request of the day),
 *     so visitors from LinkedIn can't leave the demo broken
 *   - demo accounts cannot change password or log everyone out
 * Only the demo contractor's data is touched – real users are never deleted.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Site = require('../models/Site');
const Attendance = require('../models/Attendance');
const MoneyRequest = require('../models/MoneyRequest');
const Payment = require('../models/Payment');
const Photo = require('../models/Photo');
const { toISTDateString, todayIST } = require('./dates');

const DEMO_CONTRACTOR_PHONE = '9000000001';
const DEMO_PHONES = ['9000000001', '9000000002', '9000000003', '9000000004'];

const demoMode = () => String(process.env.DEMO_MODE).toLowerCase() === 'true';

function isProtectedDemoUser(user) {
  return demoMode() && DEMO_PHONES.includes(user.phone);
}

// Removes ONLY the demo contractor and everything that belongs to it
async function removeDemoData() {
  const demo = await User.findOne({ phone: DEMO_CONTRACTOR_PHONE, role: 'contractor' });
  if (demo) {
    const byContractor = { contractor: demo._id };
    await Promise.all([
      Attendance.deleteMany(byContractor),
      Payment.deleteMany(byContractor),
      MoneyRequest.deleteMany(byContractor),
      Site.deleteMany(byContractor),
      Photo.deleteMany(byContractor),
    ]);
    await User.deleteMany({ role: 'worker', contractor: demo._id });
  }
  await User.deleteMany({ phone: { $in: DEMO_PHONES } });
}

async function createDemoData() {
  const passwordHash = await bcrypt.hash('demo123', 10);

  const contractor = await User.create({
    role: 'contractor',
    name: 'Shivanand',
    phone: DEMO_CONTRACTOR_PHONE,
    passwordHash,
    companyName: 'Shiva Build Mart',
    joinCode: 'SHIVA1',
    language: 'en',
    workerCounter: 2,
    settings: { spotCheckNew: 0.3, spotCheckTrusted: 0.1 },
  });

  // Site in Whitefield, Bengaluru (change to your real site location)
  const site = await Site.create({
    contractor: contractor._id,
    name: 'Whitefield Villa – Kitchen & Wardrobes',
    address: 'Whitefield, Bengaluru',
    clientName: 'Mr. Sharma',
    lat: 12.9698,
    lng: 77.75,
    radiusMeters: 150,
  });

  const validTill = new Date();
  validTill.setFullYear(validTill.getFullYear() + 1);
  const joined = new Date(Date.now() - 45 * 864e5); // approved 45 days ago

  const ravi = await User.create({
    role: 'worker', name: 'Ravi Kumar', phone: '9000000002', passwordHash, contractor: contractor._id,
    trade: 'carpenter', workerCode: 'US-0001', status: 'active', level: 'skilled', suggestedLevel: 'skilled',
    dailyWage: 1000, assignedSite: site._id, nativePlace: 'Gorakhpur, UP', bloodGroup: 'B+',
    emergencyContact: { name: 'Sunita (wife)', phone: '9000000102' }, cleanDays: 34,
    skill: { experienceYears: 8, tools: ['circular saw', 'router', 'drill'], workTypes: ['wardrobe', 'kitchen', 'bed'], canReadDrawings: true },
    idValidTill: validTill, approvedAt: joined, locationConsentAt: joined,
  });

  const suresh = await User.create({
    role: 'worker', name: 'Suresh Gowda', phone: '9000000003', passwordHash, contractor: contractor._id,
    trade: 'painter', workerCode: 'US-0002', status: 'active', level: 'semi_skilled', suggestedLevel: 'semi_skilled',
    dailyWage: 800, assignedSite: site._id, nativePlace: 'Tumakuru, KA', language: 'kn',
    emergencyContact: { name: 'Manju (brother)', phone: '9000000103' }, cleanDays: 5,
    skill: { experienceYears: 3, tools: ['spray gun'], workTypes: ['interior paint', 'putty'] },
    idValidTill: validTill, approvedAt: joined,
  });

  await User.create({
    role: 'worker', name: 'Imran Khan', phone: '9000000004', passwordHash, contractor: contractor._id,
    trade: 'electrician', status: 'pending', level: 'skilled', suggestedLevel: 'skilled', dailyWage: 1000,
    nativePlace: 'Bidar, KA', emergencyContact: { name: 'Salma', phone: '9000000104' },
    skill: { experienceYears: 6, tools: ['multimeter', 'drill'], workTypes: ['wiring', 'panel', 'lights'], canReadDrawings: true },
  });

  // Last 6 days of attendance
  const records = [];
  for (let i = 6; i >= 1; i--) {
    const date = toISTDateString(new Date(Date.now() - i * 864e5));
    const inAt = new Date(`${date}T09:05:00+05:30`);
    const outAt = new Date(`${date}T18:10:00+05:30`);
    const base = { contractor: contractor._id, site: site._id, date, hours: 9.08 };

    // Ravi stayed late on one day → 1 hour overtime
    const lateDay = i === 4;
    records.push({
      ...base, worker: ravi._id, wageRate: 1000, status: 'auto_approved', dayValue: 1,
      hours: lateDay ? 10.08 : 9.08,
      overtimeHours: lateDay ? 1.08 : 0.08,
      overtimePay: lateDay ? 135 : 10,
      checkIn: { at: inAt, lat: 12.9699, lng: 77.7501, distance: 15, accuracy: 12 },
      checkOut: { at: lateDay ? new Date(outAt.getTime() + 36e5) : outAt, lat: 12.9697, lng: 77.7499, distance: 18, accuracy: 10 },
      workNote: ['Kitchen base cabinets fixed', 'Wardrobe carcass done', 'Shutters fitted', 'Loft boxes done', 'Hinges and channels', 'Handles + finishing'][6 - i],
    });

    if (i === 2) {
      records.push({
        ...base, worker: suresh._id, wageRate: 800, status: 'flagged', dayValue: 0, hours: 3.2,
        flags: ['too_few_hours', 'no_progress_note'],
        checkIn: { at: inAt, lat: 12.9699, lng: 77.7502, distance: 22, accuracy: 15 },
        checkOut: { at: new Date(inAt.getTime() + 3.2 * 36e5), lat: 12.9699, lng: 77.7502, distance: 22, accuracy: 15 },
      });
    } else {
      records.push({
        ...base, worker: suresh._id, wageRate: 800, status: 'auto_approved', dayValue: 1,
        overtimeHours: 0.08, overtimePay: 8,
        checkIn: { at: inAt, lat: 12.9699, lng: 77.7502, distance: 22, accuracy: 15 },
        checkOut: { at: outAt, lat: 12.9698, lng: 77.75, distance: 5, accuracy: 9 },
        workNote: 'Wall putty and primer, living room',
      });
    }
  }
  await Attendance.insertMany(records);

  const payDay = toISTDateString(new Date(Date.now() - 3 * 864e5));
  await Payment.create([
    { worker: ravi._id, contractor: contractor._id, amount: 2000, kind: 'advance', method: 'upi', paidOn: payDay, status: 'confirmed', confirmedAt: new Date() },
    { worker: suresh._id, contractor: contractor._id, amount: 1500, kind: 'wage', method: 'cash', paidOn: payDay, status: 'pending_confirmation' },
  ]);

  await MoneyRequest.create({
    worker: ravi._id, contractor: contractor._id, amount: 1500, type: 'emergency', reason: 'Son school fees',
  });
}

/**
 * Rebuild demo data.
 *   wipeAll = true → clears the WHOLE database first (npm run seed, local only!)
 *   wipeAll = false → only the demo contractor's data is replaced
 */
async function seedDemo({ wipeAll = false } = {}) {
  if (wipeAll) {
    await Promise.all([User, Site, Attendance, MoneyRequest, Payment, Photo].map((M) => M.deleteMany({})));
  } else {
    await removeDemoData();
  }
  await createDemoData();
}

/**
 * Express middleware: in DEMO_MODE, the first request each day resets the demo.
 * An atomic "claim" in the meta collection makes sure only one request does the reset.
 */
function demoAutoReset() {
  let checkedOn = null; // in-memory shortcut so we hit the DB at most once per day per server
  return async (req, res, next) => {
    if (!demoMode()) return next();
    const today = todayIST();
    if (checkedOn === today) return next();
    checkedOn = today;
    try {
      const meta = mongoose.connection.collection('meta');
      const claim = await meta.updateOne(
        { _id: 'demo', resetOn: { $ne: today } },
        { $set: { resetOn: today } },
        { upsert: true }
      );
      if (claim.modifiedCount || claim.upsertedCount) {
        await seedDemo({ wipeAll: false });
        console.log(`🔄 Demo data reset for ${today}`);
      }
    } catch (err) {
      // Duplicate key = another request already claimed today's reset → nothing to do
      if (err.code !== 11000) console.error('Demo reset failed:', err.message);
    }
    next();
  };
}

module.exports = { seedDemo, demoAutoReset, isProtectedDemoUser, DEMO_PHONES };
