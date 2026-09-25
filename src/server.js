require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();

// cross-origin resource policy lets the frontend (another domain after deploy) show photos
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// Allowed frontends: the website(s) in CLIENT_URL (comma separated) + the Android app (Capacitor)
const allowedOrigins = [
  ...(process.env.CLIENT_URL || 'http://localhost:5173').split(',').map((s) => s.trim()),
  'https://localhost', // Capacitor Android app
  'capacitor://localhost', // Capacitor iOS app
];
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  })
);

// Photo uploads need a bigger body limit, so they are mounted before the normal JSON parser
app.use('/api/photos', express.json({ limit: '1mb' }), require('./routes/photos'));
app.use(express.json({ limit: '100kb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Slow down password guessing on login/register
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Upasthiti Setu' }));
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/contractor', require('./routes/contractor'));
app.use('/api/workers', require('./routes/workers'));
app.use('/api/sites', require('./routes/sites'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/money', require('./routes/money'));
app.use('/api/verify', require('./routes/verify'));

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  if (!process.env.JWT_SECRET) {
    console.error('❌ JWT_SECRET missing. Copy .env.example to .env first.');
    process.exit(1);
  }
  connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/upasthiti_setu')
    .then(() => app.listen(PORT, () => console.log(`🚀 Upasthiti Setu API on http://localhost:${PORT}`)))
    .catch((err) => {
      console.error('❌ Could not connect to MongoDB:', err.message);
      process.exit(1);
    });
}

module.exports = app;
