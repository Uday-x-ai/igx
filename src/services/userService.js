const crypto = require("crypto");
const { collection, nextSequence } = require("../data/db");

function randomCode(bytes = 5) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function ensureUser(telegramId) {
  let user = await collection("users").findOne({ telegram_id: telegramId }, { projection: { _id: 0 } });
  if (!user) {
    const privateKey = randomCode(16);
    const referralCode = randomCode(4);
    await collection("users").insertOne({
      id: await nextSequence("users"),
      telegram_id: telegramId,
      balance: 0,
      private_key: privateKey,
      referral_code: referralCode,
      referred_by: null,
      last_redeem_at: null,
      created_at: new Date().toISOString(),
    });
    user = await collection("users").findOne({ telegram_id: telegramId }, { projection: { _id: 0 } });
  }
  return user;
}

async function getUserByTelegramId(telegramId) {
  return collection("users").findOne({ telegram_id: telegramId }, { projection: { _id: 0 } });
}

async function getUserById(userId) {
  return collection("users").findOne({ id: userId }, { projection: { _id: 0 } });
}

async function getUserByPrivateKey(privateKey) {
  return collection("users").findOne({ private_key: privateKey }, { projection: { _id: 0 } });
}

async function getUserByReferralCode(code) {
  return collection("users").findOne({ referral_code: code }, { projection: { _id: 0 } });
}

async function setReferredBy(userId, referrerId) {
  await collection("users").updateOne(
    { id: userId, referred_by: null },
    { $set: { referred_by: referrerId } }
  );
}

async function updateLastRedeem(userId, isoTime) {
  await collection("users").updateOne({ id: userId }, { $set: { last_redeem_at: isoTime } });
}

async function addBalance(userId, amount, type, description) {
  await collection("users").updateOne({ id: userId }, { $inc: { balance: amount } });
  await collection("transactions").insertOne({
    id: await nextSequence("transactions"),
    user_id: userId,
    type,
    amount,
    description: description || null,
    created_at: new Date().toISOString(),
  });
}

async function getReferralStats(userId) {
  const totalReferrals = await collection("users").countDocuments({ referred_by: userId });
  const rows = await collection("transactions")
    .aggregate([
      { $match: { user_id: userId, type: "referral_reward" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ])
    .toArray();
  const earnings = rows[0]?.total || 0;
  return { totalReferrals, earnings };
}

async function importAccount(fromTelegramId, privateKey) {
  const source = await getUserByPrivateKey(privateKey);
  if (!source) {
    throw new Error("Invalid private key.");
  }

  const current = await ensureUser(fromTelegramId);
  if (current.id === source.id) {
    return source;
  }

  await collection("emails").updateMany({ owner_id: source.id }, { $set: { owner_id: current.id } });
  await collection("users").updateOne({ id: current.id }, { $inc: { balance: source.balance || 0 } });
  await collection("users").updateOne({ id: source.id }, { $set: { balance: 0 } });
  await collection("shared_access").deleteMany({ user_id: source.id });

  return ensureUser(fromTelegramId);
}

module.exports = {
  ensureUser,
  getUserByTelegramId,
  getUserById,
  getUserByPrivateKey,
  getUserByReferralCode,
  setReferredBy,
  updateLastRedeem,
  addBalance,
  getReferralStats,
  importAccount,
};
