const mongoose = require('mongoose');

/**
 * Worker asks for money in the app instead of asking in person.
 * pending → approved → paid
 *        └→ declined
 */
const moneyRequestSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contractor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    type: { type: String, enum: ['advance', 'wages', 'emergency'], default: 'advance' },
    reason: { type: String, trim: true },
    status: { type: String, enum: ['pending', 'approved', 'declined', 'paid'], default: 'pending' },
    approvedAmount: { type: Number },
    decisionNote: { type: String, trim: true },
    decidedAt: { type: Date },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MoneyRequest', moneyRequestSchema);
