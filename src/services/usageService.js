const { collection } = require("../data/db");

async function increment(command) {
  await collection("command_usage").updateOne(
    { command },
    {
      $inc: { total_count: 1 },
      $set: { last_used_at: new Date().toISOString() },
      $setOnInsert: { command },
    },
    { upsert: true }
  );
}

async function getTop(limit = 20) {
  return collection("command_usage")
    .find({}, { projection: { _id: 0, command: 1, total_count: 1, last_used_at: 1 } })
    .sort({ total_count: -1, command: 1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  increment,
  getTop,
};
