/**
 * Demo data so the app doesn't look empty in a demo / interview.
 * Run: npm run seed   (WARNING: clears the WHOLE database first – use only on a test database)
 *
 * On the live server, set DEMO_MODE=true instead: the demo data then resets itself daily
 * without touching real users (see src/utils/demo.js).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { seedDemo } = require('./utils/demo');

async function run() {
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/upasthiti_setu');
  await seedDemo({ wipeAll: true });
  console.log('🌱 Demo data ready.');
  console.log('   Contractor login: 9000000001 / demo123   (join code SHIVA1)');
  console.log('   Worker logins   : 9000000002, 9000000003, 9000000004 (pending) / demo123');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
