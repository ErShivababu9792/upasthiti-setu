const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(user) {
  // tv = token version. Changing password / "log out everywhere" bumps it, so old tokens stop working.
  return jwt.sign({ id: user._id, role: user.role, tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

// Verifies the JWT and loads the current user on req.user
async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Please log in' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'Account not found' });
    if ((decoded.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ message: 'You were logged out. Please log in again' });
    }

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

module.exports = { protect, allow, activeWorker, signToken };
