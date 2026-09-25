const mongoose = require('mongoose');

/**
 * Every rupee given to a worker.
 * Contractor enters it → worker confirms "Received" or disputes it.
 * Disputed payments are NOT counted in the ledger until resolved.
 */
const paymentSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contractor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: ['wage', 'advance'], default: 'wage' },
    method: { type: String, enum: ['cash', 'upi', 'bank'], default: 'cash' },
    note: { type: String, trim: true },
    paidOn: { type: String }, // YYYY-MM-DD
    request: { type: mongoose.Schema.Types.ObjectId, ref: 'MoneyRequest' },
    status: {
      type: String,
      enum: ['pending_confirmation', 'confirmed', 'disputed'],
      default: 'pending_confirmation',
    },
    disputeReason: { type: String, trim: true },
    confirmedAt: { type: Date },
  },
  { timestamps: true }
);

// Second safety net against double payment: one money request can have only one payment
paymentSchema.index({ request: 1 }, { unique: true, partialFilterExpression: { request: { $exists: true } } });

module.exports = mongoose.model('Payment', paymentSchema);
