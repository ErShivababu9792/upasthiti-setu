const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Verifies the JWT and loads the current user on req.user
async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Please log in' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'Account not found' });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Session expired, please log in again' });
  }
}

// Role-based access: allow('contractor') or allow('worker')
function allow(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You are not allowed to do this' });
    }
    next();
  };
}

// Worker must be approved before using attendance / money features
function activeWorker(req, res, next) {
  if (req.user.role === 'worker' && req.user.status !== 'active') {
    return res.status(403).json({ message: 'Your profile is waiting for contractor approval' });
  }
  next();
}

module.exports = { protect, allow, activeWorker };
