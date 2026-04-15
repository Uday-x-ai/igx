const crypto = require("crypto");
const { collection, nextSequence } = require("../data/db");
const { economy, cpanel } = require("../config");
const { createEmailAccount, deleteEmailAccount } = require("./cpanelClient");
const {
  getCpanelAccountById,
  getNextCpanelAccount,
  getNextCpanelAccountForDomain,
  getCpanelAccountForEmailRow,
} = require("./cpanelAccountService");

const generateCooldownByUser = new Map();

function normalizeEmailAddress(emailAddress) {
  return String(emailAddress || "").trim().toLowerCase();
}

function decodeQuotedPrintable(input) {
  return String(input || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMultipartText(body) {
  const raw = String(body || "");
  const boundaryMatch = raw.match(/(?:^|\n)--([A-Za-z0-9'()+_.,\/:?= -]{8,})/);
  if (!boundaryMatch) {
    return raw;
  }

  const boundary = boundaryMatch[1].trim();
  const segments = raw.split(`--${boundary}`);
  let htmlFallback = "";

  for (const segment of segments) {
    const part = segment.trim();
    if (!part || part === "--") {
      continue;
    }

    const splitIndex = part.search(/\r?\n\r?\n/);
    if (splitIndex < 0) {
      continue;
    }

    const headerText = part.slice(0, splitIndex).toLowerCase();
    const payload = part.slice(splitIndex).replace(/^\r?\n\r?\n/, "");

    const isPlain = headerText.includes("content-type: text/plain");
    const isHtml = headerText.includes("content-type: text/html");
    const isBase64 = headerText.includes("content-transfer-encoding: base64");
    const isQuoted = headerText.includes("content-transfer-encoding: quoted-printable");

    let decoded = payload;
    if (isBase64) {
      try {
        decoded = Buffer.from(payload.replace(/\s+/g, ""), "base64").toString("utf8");
      } catch (err) {
        decoded = payload;
      }
    } else if (isQuoted) {
      decoded = Buffer.from(decodeQuotedPrintable(payload), "binary").toString("utf8");
    }

    if (isPlain && decoded.trim()) {
      return decoded.trim();
    }

    if (isHtml && decoded.trim() && !htmlFallback) {
      htmlFallback = htmlToText(decoded);
    }
  }

  return htmlFallback || raw;
}

function randomLocalPart() {
  return `tmp${crypto.randomBytes(4).toString("hex")}`;
}

function canGenerateNow(userId) {
  const now = Date.now();
  const last = generateCooldownByUser.get(userId) || 0;
  if (now - last < 5000) {
    return false;
  }
  generateCooldownByUser.set(userId, now);
  return true;
}

async function generateEmailForUser(user, requestedDomain = "") {
  if (!canGenerateNow(user.id)) {
    throw new Error("Too many requests. Please wait a few seconds.");
  }

  if (user.balance < economy.generateCost) {
    throw new Error("Insufficient points. Use /redeem or /addbal.");
  }

  const normalizedRequestedDomain = String(requestedDomain || "").trim().toLowerCase();
  const cpanelAccount = normalizedRequestedDomain
    ? await getNextCpanelAccountForDomain(normalizedRequestedDomain)
    : await getNextCpanelAccount();
  if (!cpanelAccount) {
    if (normalizedRequestedDomain) {
      throw new Error(`Domain not available: ${normalizedRequestedDomain}`);
    }
    throw new Error("No cPanel account configured. Ask admin to add one in /panel.");
  }

  const accountDomains = Array.isArray(cpanelAccount.domains)
    ? cpanelAccount.domains.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : [];

  const selectedDomain = normalizedRequestedDomain || cpanelAccount.domain || accountDomains[0] || "";
  if (!selectedDomain) {
    throw new Error("No domain configured for selected cPanel account.");
  }

  if (normalizedRequestedDomain && accountDomains.length && !accountDomains.includes(normalizedRequestedDomain)) {
    throw new Error(`Domain not available: ${normalizedRequestedDomain}`);
  }

  const localPart = randomLocalPart();
  const randomPassword = crypto.randomBytes(12).toString("base64url");
  const fullEmail = `${localPart}@${selectedDomain}`;

  try {
    await createEmailAccount(localPart, randomPassword, cpanelAccount, selectedDomain);
  } catch (err) {
    if (!cpanelAccount.strictMode && !cpanel.strictMode) {
      console.warn("cPanel create failed; continuing due to CPANEL_STRICT_MODE=false:", err.message);
    } else {
      throw new Error(`Email creation failed: ${err.message}`);
    }
  }

  const debitedUser = await collection("users").findOneAndUpdate(
    { id: user.id, balance: { $gte: economy.generateCost } },
    { $inc: { balance: -economy.generateCost } },
    { returnDocument: "after", projection: { _id: 0 } }
  );
  if (!debitedUser) {
    throw new Error("Insufficient points. Use /redeem or /addbal.");
  }

  await collection("emails").insertOne({
    id: await nextSequence("emails"),
    email: fullEmail,
    owner_id: user.id,
    status: "active",
    cpanel_account_id: cpanelAccount.id ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await collection("transactions").insertOne({
    id: await nextSequence("transactions"),
    user_id: user.id,
    type: "email_generate",
    amount: -economy.generateCost,
    description: `Generated ${fullEmail}`,
    created_at: new Date().toISOString(),
  });

  return fullEmail;
}

async function listOwnedEmails(userId) {
  return collection("emails")
    .find({ owner_id: userId }, { projection: { _id: 0, id: 1, email: 1, status: 1, created_at: 1 } })
    .sort({ id: 1 })
    .toArray();
}

async function listAccessibleEmails(userId) {
  const owned = await collection("emails")
    .find(
      { status: "active", owner_id: userId },
      { projection: { _id: 0, id: 1, email: 1, status: 1, created_at: 1 } }
    )
    .toArray();

  const sharedRows = await collection("shared_access")
    .find({ user_id: userId }, { projection: { _id: 0, email_id: 1 } })
    .toArray();
  const sharedIds = sharedRows.map((row) => row.email_id);

  const shared = sharedIds.length
    ? await collection("emails")
      .find(
        { id: { $in: sharedIds }, status: "active", owner_id: { $ne: userId } },
        { projection: { _id: 0, id: 1, email: 1, status: 1, created_at: 1 } }
      )
      .toArray()
    : [];

  const rows = [
    ...owned.map((row) => ({ ...row, access_type: "owner" })),
    ...shared.map((row) => ({ ...row, access_type: "shared" })),
  ];

  return rows.sort((a, b) => b.id - a.id);
}

async function getEmailByAddress(email) {
  return collection("emails").findOne({ email: normalizeEmailAddress(email) }, { projection: { _id: 0 } });
}

async function listActiveEmailAddresses() {
  const rows = await collection("emails")
    .find({ status: "active" }, { projection: { _id: 0, email: 1 } })
    .sort({ id: 1 })
    .toArray();
  return rows.map((row) => row.email);
}

async function listActiveEmailRecords() {
  return collection("emails")
    .find({ status: "active" }, { projection: { _id: 0, email: 1, cpanel_account_id: 1 } })
    .sort({ id: 1 })
    .toArray();
}

async function getAccessibleEmailForUser(emailAddress, userId) {
  const email = await getEmailByAddress(emailAddress);
  if (!email || email.status !== "active") {
    return null;
  }

  if (email.owner_id === userId) {
    return email;
  }

  const shared = await collection("shared_access").findOne(
    { email_id: email.id, user_id: userId },
    { projection: { _id: 1 } }
  );

  return shared ? email : null;
}

function buildExternalId(message) {
  if (message?.messageId) {
    return String(message.messageId);
  }

  const raw = [
    message?.to || "",
    message?.from || "",
    message?.subject || "",
    message?.date || "",
    message?.body || "",
  ].join("|");

  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function saveReceivedMail(emailAddress, message) {
  const normalizedEmail = normalizeEmailAddress(emailAddress);
  const email = await getEmailByAddress(normalizedEmail);
  if (!email || email.status !== "active") {
    return false;
  }

  const externalId = buildExternalId(message);
  try {
    await collection("received_mails").insertOne({
      id: await nextSequence("received_mails"),
      email_id: email.id,
      external_id: externalId,
      from_address: message?.from || null,
      subject: message?.subject || null,
      body: message?.body || null,
      received_at: message?.date || null,
      created_at: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    if (err?.code === 11000) {
      return false;
    }
    throw err;
  }
}

async function getReceivedMailsForUser(emailAddress, userId, limit = 10) {
  const email = await getAccessibleEmailForUser(normalizeEmailAddress(emailAddress), userId);
  if (!email) {
    throw new Error("Email not found or you do not have access.");
  }

  const rows = await collection("received_mails")
    .find(
      { email_id: email.id },
      { projection: { _id: 0, from_address: 1, subject: 1, body: 1, received_at: 1, created_at: 1 } }
    )
    .sort({ id: -1 })
    .limit(limit)
    .toArray();

  return rows.map((row) => ({
    ...row,
    body: extractMultipartText(row.body),
  }));
}

async function transferEmail(emailAddress, fromUserId, toUserId) {
  const email = await getEmailByAddress(normalizeEmailAddress(emailAddress));
  if (!email || email.status !== "active") {
    throw new Error("Email not found or not active.");
  }
  if (email.owner_id !== fromUserId) {
    throw new Error("You are not the owner of this email.");
  }

  await collection("emails").updateOne(
    { id: email.id },
    { $set: { owner_id: toUserId, updated_at: new Date().toISOString() } }
  );
  await collection("shared_access").deleteMany({ email_id: email.id });
}

async function transferByIndex(fromUserId, index, toUserId) {
  const rows = (await listOwnedEmails(fromUserId)).filter((r) => r.status === "active");
  const row = rows[index - 1];
  if (!row) {
    throw new Error("Invalid email index.");
  }
  await transferEmail(row.email, fromUserId, toUserId);
  return row.email;
}

async function deleteEmail(emailAddress, userId) {
  const email = await getEmailByAddress(normalizeEmailAddress(emailAddress));
  if (!email || email.status !== "active") {
    throw new Error("Email not found or already deleted.");
  }
  if (email.owner_id !== userId) {
    throw new Error("You are not the owner of this email.");
  }

  try {
    const cpanelAccount = (await getCpanelAccountForEmailRow(email)) || (await getCpanelAccountById(null));
    await deleteEmailAccount(emailAddress, cpanelAccount);
  } catch (err) {
    const cpanelAccount = await getCpanelAccountForEmailRow(email);
    if (!cpanelAccount?.strictMode && !cpanel.strictMode) {
      console.warn("cPanel delete failed; continuing due to CPANEL_STRICT_MODE=false:", err.message);
    } else {
      throw new Error(`Email delete failed: ${err.message}`);
    }
  }

  await collection("emails").updateOne(
    { id: email.id },
    { $set: { status: "deleted", owner_id: null, updated_at: new Date().toISOString() } }
  );
  await collection("shared_access").deleteMany({ email_id: email.id });
}

async function acceptDeletedEmail(emailAddress, userId) {
  const email = await getEmailByAddress(normalizeEmailAddress(emailAddress));
  if (!email || email.status !== "deleted") {
    throw new Error("Email is not available for reclaim.");
  }

  await collection("emails").updateOne(
    { id: email.id },
    { $set: { status: "active", owner_id: userId, updated_at: new Date().toISOString() } }
  );
}

async function shareEmail(emailAddress, ownerId, targetUserId) {
  const email = await getEmailByAddress(normalizeEmailAddress(emailAddress));
  if (!email || email.status !== "active") {
    throw new Error("Email not found or inactive.");
  }
  if (email.owner_id !== ownerId) {
    throw new Error("Only owner can share this email.");
  }

  await collection("shared_access").updateOne(
    { email_id: email.id, user_id: targetUserId },
    { $setOnInsert: { created_at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function stopShareEmail(emailAddress, ownerId) {
  const email = await getEmailByAddress(normalizeEmailAddress(emailAddress));
  if (!email) {
    throw new Error("Email not found.");
  }
  if (email.owner_id !== ownerId) {
    throw new Error("Only owner can stop share access.");
  }

  await collection("shared_access").deleteMany({ email_id: email.id });
}

async function getRecipientsForEmail(emailAddress) {
  const email = await getEmailByAddress(normalizeEmailAddress(emailAddress));
  if (!email || email.status !== "active") {
    return [];
  }

  const owner = await collection("users").findOne(
    { id: email.owner_id },
    { projection: { _id: 0, telegram_id: 1 } }
  );

  const sharedAccess = await collection("shared_access")
    .find({ email_id: email.id }, { projection: { _id: 0, user_id: 1 } })
    .toArray();

  const sharedUserIds = sharedAccess.map((row) => row.user_id);
  const shared = sharedUserIds.length
    ? await collection("users")
      .find({ id: { $in: sharedUserIds } }, { projection: { _id: 0, telegram_id: 1 } })
      .toArray()
    : [];

  const recipients = [];
  if (owner?.telegram_id) {
    recipients.push(owner.telegram_id);
  }
  for (const row of shared) {
    recipients.push(row.telegram_id);
  }
  return [...new Set(recipients)];
}

module.exports = {
  generateEmailForUser,
  listOwnedEmails,
  listAccessibleEmails,
  listActiveEmailAddresses,
  listActiveEmailRecords,
  saveReceivedMail,
  getReceivedMailsForUser,
  transferEmail,
  transferByIndex,
  deleteEmail,
  acceptDeletedEmail,
  shareEmail,
  stopShareEmail,
  getRecipientsForEmail,
};
