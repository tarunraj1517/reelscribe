// Atomic daily quota counters. The old read-modify-write usage updates let parallel requests
// slip past the limit; these use a single conditional MongoDB update instead.

// Day key in IST so "daily" limits reset at midnight for Indian users (the server clock is UTC).
function dayKey(date = new Date()) {
  return new Date(date.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
  return dayKey(date).slice(0, 7);
}

// Returns true and consumes one unit if the user is still under `limit` today; otherwise false.
async function consumeDaily(User, userId, bucket, limit) {
  if (!limit || limit <= 0) return false;
  const today = dayKey();
  const path = `usage.${bucket}`;
  const inc = await User.findOneAndUpdate(
    { _id: userId, [`${path}.day`]: today, [`${path}.n`]: { $lt: limit } },
    { $inc: { [`${path}.n`]: 1 } },
    { new: true }
  );
  if (inc) return true;
  const reset = await User.findOneAndUpdate(
    { _id: userId, [`${path}.day`]: { $ne: today } },
    { $set: { [path]: { day: today, n: 1 } } },
    { new: true }
  );
  return !!reset;
}

async function refundDaily(User, userId, bucket) {
  const today = dayKey();
  await User.updateOne({ _id: userId, [`usage.${bucket}.day`]: today, [`usage.${bucket}.n`]: { $gt: 0 } }, { $inc: { [`usage.${bucket}.n`]: -1 } }).catch(() => {});
}

function usedToday(user, bucket) {
  const u = user?.usage?.[bucket];
  return u && u.day === dayKey() ? u.n || 0 : 0;
}

module.exports = { dayKey, monthKey, consumeDaily, refundDaily, usedToday };
