const mongoose = require('mongoose');

/**
 * One collection for both roles.
 *  - contractor: owns sites and workers, sets rules (settings)
 *  - worker: belongs to one contractor, has trade, level and daily wage
 */
const settingsSchema = new mongoose.Schema(
  {
    minHoursFullDay: { type: Number, default: 7 },
    minHoursHalfDay: { type: Number, default: 4 },
    advanceLimit: { type: Number, default: 2000 }, // extra money a worker may request beyond earned balance
    spotCheckNew: { type: Number, default: 0.3 }, // 30% random review for new workers
    spotCheckTrusted: { type: Number, default: 0.1 }, // 10% random review for trusted workers
    trustedAfterDays: { type: Number, default: 30 },
    idValidityMonths: { type: Number, default: 12 },
    requireProgressPhoto: { type: Boolean, default: false }, // true = a photo is compulsory at check-out
  },
  { _id: false }
);

const skillSchema = new mongoose.Schema(
  {
    experienceYears: { type: Number, default: 0 },
    tools: [{ type: String }],
    workTypes: [{ type: String }],
    canReadDrawings: { type: Boolean, default: false },
    canLeadTeam: { type: Boolean, default: false },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['contractor', 'worker'], required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    language: { type: String, enum: ['en', 'hi'], default: 'hi' },

    // ---- contractor fields ----
    companyName: { type: String, trim: true },
    joinCode: { type: String, unique: true, sparse: true }, // workers use this to join
    settings: { type: settingsSchema, default: () => ({}) },
    workerCounter: { type: Number, default: 0 },

    // ---- worker fields ----
    contractor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    workerCode: { type: String }, // e.g. US-0007
    trade: { type: String, enum: ['carpenter', 'painter', 'electrician', 'plumber', 'mason', 'helper', 'other'] },
    skill: { type: skillSchema },
    suggestedLevel: { type: String, enum: ['helper', 'semi_skilled', 'skilled', 'head_mistri'] },
    level: { type: String, enum: ['helper', 'semi_skilled', 'skilled', 'head_mistri'] },
    dailyWage: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'active', 'rejected', 'inactive'] },
    assignedSite: { type: mongoose.Schema.Types.ObjectId, ref: 'Site' },
    photoKey: { type: String }, // profile photo (see Photo model) – shown on ID card and verify page
    nativePlace: { type: String, trim: true },
    emergencyContact: { name: String, phone: String },
    bloodGroup: { type: String },
    upiId: { type: String, trim: true },
    cleanDays: { type: Number, default: 0 }, // trust score: auto-approved days in a row
    idVersion: { type: Number, default: 1 }, // bump to invalidate old ID card QR codes
    idValidTill: { type: Date },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
