const mongoose = require('mongoose');

/**
 * Photos are compressed on the phone (≈50–150 KB JPEG) and stored in MongoDB.
 * This keeps setup simple: no extra cloud account needed, and it works on
 * MongoDB Atlas + Render without a persistent disk.
 * (At scale you would move the bytes to S3 / Cloudinary and keep only the URL.)
 *
 * `key` is a random 24-character id used in URLs, so photo links cannot be guessed.
 */
const photoSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contractor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    kind: { type: String, enum: ['profile', 'progress'], required: true },
    mime: { type: String, default: 'image/jpeg' },
    size: { type: Number },
    data: { type: Buffer, required: true, select: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Photo', photoSchema);
