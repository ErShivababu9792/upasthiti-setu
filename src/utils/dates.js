/**
 * All attendance dates are stored as YYYY-MM-DD in India time (UTC+05:30),
 * so a 11:30 PM check-out still belongs to the same working day.
 */
const IST_OFFSET_MIN = 330;

function toISTDateString(date = new Date()) {
  const ist = new Date(date.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function todayIST() {
  return toISTDateString(new Date());
}

// Monday-based week containing the given date string
function weekRange(dateStr = todayIST()) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - day);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

module.exports = { toISTDateString, todayIST, weekRange };
