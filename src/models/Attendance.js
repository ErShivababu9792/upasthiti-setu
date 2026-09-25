const mongoose = require('mongoose');

const pointSchema = new mongoose.Schema(
  {
    at: { type: Date },
    lat: Number,
    lng: Number,
    accuracy: Number, // GPS accuracy reported by the phone, in metres
    distance: Number, // metres from site centre
  },
  { _id: false }
);

/**
 * One document per worker per day.
 * status flow:
 *   in_progress → auto_approved | half_day | flagged
 *   flagged     → approved | half_day | rejected   (after contractor review)
 */
const attendanceSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contractor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    site: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD in India time
    checkIn: { type: pointSchema },
    checkOut: { type: pointSchema },
    workNote: { type: String, trim: true }, // optional description of the work
    photos: [{ type: String }], // progress photo keys (watermarked on the phone) – proof of work
    hours: { type: Number, default: 0 },
    wageRate: { type: Number, required: true }, // daily wage frozen at check-in, so later wage changes don't rewrite history
    status: {
      type: String,
      enum: ['in_progress', 'auto_approved', 'half_day', 'flagged', 'approved', 'rejected'],
      default: 'in_progress',
    },
    flags: [{ type: String }], // reasons why it needs review
    dayValue: { type: Number, default: 0 }, // 1 = full day, 0.5 = half day, 0 = not counted
    correctionRequest: { type: String, trim: true }, // worker's explanation for a flagged day
    reviewNote: { type: String, trim: true },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

attendanceSchema.index({ worker: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
