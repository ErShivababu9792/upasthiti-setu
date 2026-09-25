/**
 * Demo data so the app doesn't look empty in a demo / interview.
 * Run: npm run seed   (WARNING: clears the database first)
 *
 * Logins (password for all: demo123)
 *   Contractor : 9000000001
 *   Workers    : 9000000002 (Ravi, active), 9000000003 (Suresh, active), 9000000004 (Imran, pending)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const connectDB = require('./config/db');
const User = require('./models/User');
const Site = require('./models/Site');
const Attendance = require('./models/Attendance');
const MoneyRequest = require('./models/MoneyRequest');
const Payment = require('./models/Payment');
const { toISTDateString } = require('./utils/dates');

async function run() {
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/upasthiti_setu');
  await Promise.all([User, Site, Attendance, MoneyRequest, Payment].map((M) => M.deleteMany({})));

  const passwordHash = await bcrypt.hash('demo123', 10);

  const contractor = await User.create({
    role: 'contractor',
    name: 'Shivanand',
    phone: '9000000001',
    passwordHash,
    companyName: 'Shiva Build Mart',
    joinCode: 'SHIVA1',
    language: 'en',
    workerCounter: 2,
    settings: { spotCheckNew: 0.3, spotCheckTrusted: 0.1 },
  });

  // Site near MG Road, Bengaluru (change to your real site location)
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

  const ravi = await User.create({
    role: 'worker', name: 'Ravi Kumar', phone: '9000000002', passwordHash, contractor: contractor._id,
    trade: 'carpenter', workerCode: 'US-0001', status: 'active', level: 'skilled', suggestedLevel: 'skilled',
    dailyWage: 1000, assignedSite: site._id, nativePlace: 'Gorakhpur, UP', bloodGroup: 'B+',
    emergencyContact: { name: 'Sunita (wife)', phone: '9000000102' }, cleanDays: 34,
    skill: { experienceYears: 8, tools: ['circular saw', 'router', 'drill'], workTypes: ['wardrobe', 'kitchen', 'bed'], canReadDrawings: true },
    idValidTill: validTill, approvedAt: new Date(),
  });

  const suresh = await User.create({
    role: 'worker', name: 'Suresh Gowda', phone: '9000000003', passwordHash, contractor: contractor._id,
    trade: 'painter', workerCode: 'US-0002', status: 'active', level: 'semi_skilled', suggestedLevel: 'semi_skilled',
    dailyWage: 800, assignedSite: site._id, nativePlace: 'Tumakuru, KA',
    emergencyContact: { name: 'Manju (brother)', phone: '9000000103' }, cleanDays: 5,
    skill: { experienceYears: 3, tools: ['spray gun'], workTypes: ['interior paint', 'putty'] },
    idValidTill: validTill, approvedAt: new Date(),
  });

  await User.create({
    role: 'worker', name: 'Imran Khan', phone: '9000000004', passwordHash, contractor: contractor._id,
    trade: 'electrician', status: 'pending', level: 'skilled', suggestedLevel: 'skilled', dailyWage: 1000,
    nativePlace: 'Bidar, KA', emergencyContact: { name: 'Salma', phone: '9000000104' },
    skill: { experienceYears: 6, tools: ['multimeter', 'drill'], workTypes: ['wiring', 'panel', 'lights'], canReadDrawings: true },
  });

  // Last 6 working days of attendance
  const records = [];
  for (let i = 6; i >= 1; i--) {
    const day = new Date(Date.now() - i * 864e5);
    const date = toISTDateString(day);
    const inAt = new Date(`${date}T09:05:00+05:30`);
    const outAt = new Date(`${date}T18:10:00+05:30`);
    const base = { contractor: contractor._id, site: site._id, date, hours: 9.08 };

    records.push({
      ...base, worker: ravi._id, wageRate: 1000, status: 'auto_approved', dayValue: 1,
      checkIn: { at: inAt, lat: 12.9699, lng: 77.7501, distance: 15, accuracy: 12 },
      checkOut: { at: outAt, lat: 12.9697, lng: 77.7499, distance: 18, accuracy: 10 },
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
        checkIn: { at: inAt, lat: 12.9699, lng: 77.7502, distance: 22, accuracy: 15 },
        checkOut: { at: outAt, lat: 12.9698, lng: 77.7500, distance: 5, accuracy: 9 },
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

  console.log('🌱 Demo data ready.');
  console.log('   Contractor login: 9000000001 / demo123   (join code SHIVA1)');
  console.log('   Worker logins   : 9000000002, 9000000003, 9000000004 (pending) / demo123');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
