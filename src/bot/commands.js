const axios = require("axios");
const { adminIds, economy, requiredChannel, requiredChannelLink, paytm, web } = require("../config");
const { collection, nextSequence } = require("../data/db");
const {
  ensureUser,
  getUserByTelegramId,
  getUserById,
  getUserByReferralCode,
  setReferredBy,
  updateLastRedeem,
  addBalance,
  getReferralStats,
  importAccount,
} = require("../services/userService");
const {
  generateEmailForUser,
  listOwnedEmails,
  getReceivedMailsForUser,
  transferEmail,
  transferByIndex,
  deleteEmail,
  acceptDeletedEmail,
  shareEmail,
  stopShareEmail,
} = require("../services/emailService");
const {
  addCpanelAccount,
  deleteCpanelAccount,
  listCpanelAccounts,
  listGenerateDomains,
  setDefaultCpanelAccount,
} = require("../services/cpanelAccountService");
const usageService = require("../services/usageService");
const { createWebAppToken } = require("../services/webAppAuth");

const bulkTransferState = new Map();
const importPrivateKeyState = new Map();
const adminPanelState = new Map();
const pendingReferralCode = new Map();
const depositIntervals = new Map();
const generateDomainState = new Map();

function parseArgs(text) {
  return (text || "").trim().split(/\s+/).slice(1);
}

function isToday(isoString) {
  if (!isoString) {
    return false;
  }
  const d = new Date(isoString);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate();
}

function isAdmin(telegramId) {
  return adminIds.includes(Number(telegramId));
}

async function usage(name) {
  await usageService.increment(name);
}

function copyEmailKeyboard(email) {
  return {
    inline_keyboard: [[{ text: "Copy Email", copy_text: { text: email } }]],
  };
}

function copyEmailListKeyboard(emails) {
  return {
    inline_keyboard: emails.map((item, idx) => [
      { text: `Copy ${idx + 1}`, copy_text: { text: item.email } },
    ]),
  };
}

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function buildGenerateDomainKeyboard(options) {
  const domainButtons = options.map((item) => ({
    text: item.domain,
    callback_data: `generate_domain:${item.token}`,
  }));

  return {
    inline_keyboard: [
      ...chunk(domainButtons, 2),
    ],
  };
}

function buildAdminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Add cPanel Account", callback_data: "panel_add_account" }],
      [{ text: "List Accounts", callback_data: "panel_list_accounts" }],
        [{ text: "Set Default Account", callback_data: "panel_set_default_account" }],
      [{ text: "Delete Account", callback_data: "panel_delete_account" }],
      [{ text: "Close", callback_data: "panel_close" }],
    ],
  };
}

function formatAdminPanelAccounts(accounts) {
  if (!accounts.length) {
    return "No cPanel accounts are configured yet.";
  }

  return accounts
    .map((account) => {
      const defaultLabel = account.isDefault ? " [default]" : "";
      const sourceLabel = account.source === "env" ? "env" : `#${account.id}`;
      const domains = Array.isArray(account.domains) && account.domains.length
        ? account.domains.join(", ")
        : account.domain;
      return [
        `${sourceLabel}${defaultLabel} ${account.name}`,
        `Domains: ${domains}`,
        `Username: ${account.username}`,
        `Base URL: ${account.baseUrl}`,
      ].join("\n");
    })
    .join("\n\n");
}

async function showAdminPanel(bot, chatId) {
  const accounts = await listCpanelAccounts();
  const text = [
    "cPanel Admin Panel",
    "",
    accounts.length ? `Configured accounts: ${accounts.length}` : "No saved cPanel accounts yet.",
    "Use the buttons below to manage accounts.",
  ].join("\n");

  await bot.sendMessage(chatId, text, {
    reply_markup: buildAdminPanelKeyboard(),
  });
}

function getAdminPanelAddSteps() {
  return [
    { key: "name", prompt: "Send account name." },
    { key: "baseUrl", prompt: "Send cPanel base URL. Example: https://server.example.com:2083" },
    { key: "username", prompt: "Send cPanel username." },
    { key: "apiToken", prompt: "Send cPanel API token." },
    { key: "domains", prompt: "Send cPanel domains (comma separated). Example: udayscripts.in, mail.udayscripts.in" },
    { key: "makeDefault", prompt: "Make this the default account? Reply yes or no." },
  ];
}

async function promptNextAdminPanelStep(bot, chatId, state) {
  const steps = getAdminPanelAddSteps();
  const currentStep = steps[state.stepIndex];
  if (!currentStep) {
    return;
  }

  await bot.sendMessage(chatId, currentStep.prompt);
}

function buildWebAppUrlForUser(telegramId) {
  if (!web.baseUrl) {
    return "";
  }

  const base = web.baseUrl.replace(/\/+$/, "");
  const token = createWebAppToken(telegramId, 1800);
  return `${base}/webapp?token=${encodeURIComponent(token)}`;
}

async function sendWebInboxButton(bot, chatId, telegramId) {
  const url = buildWebAppUrlForUser(telegramId);
  if (!url) {
    await bot.sendMessage(
      chatId,
      "Web app is not configured. Set WEB_APP_BASE_URL in environment first."
    );
    return;
  }

  await bot.sendMessage(chatId, "Open inbox web app:", {
    reply_markup: {
      inline_keyboard: [[{ text: "Open Inbox", web_app: { url } }]],
    },
  });
}

function random18Digits() {
  const min = 100000000000000000;
  const max = 999999999999999999;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

function hasPaytmConfig() {
  return paytm.enabled && paytm.mid && paytm.upiPa && paytm.verifyBaseUrl;
}

function buildPaytmVerifyUrl(paymentId) {
  const url = new URL(paytm.verifyBaseUrl);
  url.searchParams.set("mid", paytm.mid);
  url.searchParams.set("id", paymentId);
  return url.toString();
}

function stopDepositPolling(chatId) {
  const running = depositIntervals.get(chatId);
  if (!running) {
    return;
  }
  clearInterval(running.intervalId);
  depositIntervals.delete(chatId);
}

async function editDepositMessage(bot, chatId, messageId, text, keyboard) {
  if (!messageId) {
    return;
  }
  try {
    await bot.editMessageCaption(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: keyboard || undefined,
    });
  } catch (err) {
    // Ignore edit failures to avoid noisy fallback messages.
  }
}

async function markDepositCreated(userId, paymentId) {
  await collection("deposits").insertOne({
    id: await nextSequence("deposits"),
    user_id: userId,
    payment_id: paymentId,
    amount: null,
    status: "pending",
    provider_response: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function markDepositStatus(paymentId, status, amount, providerResponse) {
  const update = {
    status,
    provider_response: providerResponse || null,
    updated_at: new Date().toISOString(),
  };
  if (amount !== null && amount !== undefined) {
    update.amount = amount;
  }

  await collection("deposits").updateOne({ payment_id: paymentId }, { $set: update });
}

async function isDepositAlreadySuccessful(paymentId) {
  const row = await collection("deposits").findOne(
    { payment_id: paymentId, status: "success" },
    { projection: { _id: 1 } }
  );
  return Boolean(row);
}

async function startDepositFlow(bot, msg, user) {
  if (!hasPaytmConfig()) {
    await bot.sendMessage(
      msg.chat.id,
      "Deposit is currently unavailable. Ask admin to configure Paytm settings."
    );
    return;
  }

  if (depositIntervals.has(msg.chat.id)) {
    await bot.sendMessage(msg.chat.id, "You already have a pending deposit. Use /cancel or wait for completion.");
    return;
  }

  const paymentId = random18Digits();
  const upiIntent = `upi://pay?pa=${encodeURIComponent(paytm.upiPa)}&pn=${encodeURIComponent(
    paytm.upiPn
  )}&tr=${paymentId}&tn=${encodeURIComponent("TempMail Deposit")}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiIntent)}`;
  const last4 = paymentId.slice(-4);

  await markDepositCreated(user.id, paymentId);

  const depositMsg = await bot.sendPhoto(msg.chat.id, qrCodeUrl, {
    caption: [
      "Pay with this QR and wait for auto verification.",
      "",
      `Payment ID: XXXXXXXXXXXXXX${last4}`,
      `Full ID: ${paymentId}`,
      `Timeout: ${paytm.timeoutSeconds} seconds`,
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[{ text: "Cancel Deposit", callback_data: `deposit_cancel:${paymentId}` }]],
    },
  });
  const depositMessageId = depositMsg.message_id;

  const maxRetries = Math.max(1, Math.floor((paytm.timeoutSeconds * 1000) / paytm.pollMs));
  let retries = 0;
  let busy = false;
  const apiUrl = buildPaytmVerifyUrl(paymentId);

  const intervalId = setInterval(async () => {
    if (busy) {
      return;
    }
    busy = true;

    try {
      const response = await axios.get(apiUrl, { timeout: 15000 });
      const data = response.data || {};
      const success = data.STATUS === "TXN_SUCCESS" && data.RESPMSG === "Txn Success";

      if (success) {
        if (await isDepositAlreadySuccessful(paymentId)) {
          stopDepositPolling(msg.chat.id);
          return;
        }

        const rawAmount = Number.parseFloat(data.TXNAMOUNT);
        const points = Number.isFinite(rawAmount) ? Math.max(1, Math.round(rawAmount)) : 0;

        if (points <= 0) {
          await markDepositStatus(paymentId, "failed", null, JSON.stringify(data));
          await editDepositMessage(
            bot,
            msg.chat.id,
            depositMessageId,
            "❌ *Payment detected but amount was invalid.*\n\nPlease contact admin.",
            {
              inline_keyboard: [[{ text: "New Deposit", callback_data: "deposit_restart" }]],
            }
          );
          stopDepositPolling(msg.chat.id);
          return;
        }

        await addBalance(user.id, points, "deposit_credit", `Paytm deposit ${paymentId}`);
        await markDepositStatus(paymentId, "success", points, JSON.stringify(data));
        const refreshed = await getUserById(user.id);

        await editDepositMessage(
          bot,
          msg.chat.id,
          depositMessageId,
          `✅ *Payment of ${points} points was successful!*\n\nYour new balance is: *${refreshed.balance}*`,
          {
            inline_keyboard: [[{ text: "New Deposit", callback_data: "deposit_restart" }]],
          }
        );

        stopDepositPolling(msg.chat.id);
        return;
      }

      retries += 1;
      if (retries >= maxRetries) {
        await markDepositStatus(paymentId, "expired", null, JSON.stringify(data));
        await editDepositMessage(
          bot,
          msg.chat.id,
          depositMessageId,
          "❌ *Payment not detected within the allowed time.*\n\nPlease try again.",
          {
            inline_keyboard: [[{ text: "Retry Deposit", callback_data: "deposit_restart" }]],
          }
        );
        stopDepositPolling(msg.chat.id);
      }
    } catch (err) {
      retries += 1;
      if (retries >= maxRetries) {
        await markDepositStatus(paymentId, "failed", null, err.message);
        await editDepositMessage(
          bot,
          msg.chat.id,
          depositMessageId,
          "❌ *There was an error checking your payment.*\n\nPlease try again.",
          {
            inline_keyboard: [[{ text: "Retry Deposit", callback_data: "deposit_restart" }]],
          }
        );
        stopDepositPolling(msg.chat.id);
      }
    } finally {
      busy = false;
    }
  }, paytm.pollMs);

  depositIntervals.set(msg.chat.id, { intervalId, paymentId, userId: user.id, messageId: depositMessageId });
}

async function isUserInRequiredChannel(bot, telegramId) {
  if (!requiredChannel) {
    return true;
  }

  const parseChannelUsernameFromLink = (value) => {
    const tMeMatch = String(value || "").trim().match(/^https?:\/\/t\.me\/([A-Za-z0-9_]{5,32})\/?$/i);
    if (!tMeMatch) {
      return null;
    }
    return `@${tMeMatch[1]}`;
  };

  const channelCandidates = [requiredChannel];
  if (typeof requiredChannel === "string") {
    const usernameFromRequiredChannel = parseChannelUsernameFromLink(requiredChannel);
    if (usernameFromRequiredChannel) {
      channelCandidates.push(usernameFromRequiredChannel);
    }
  }

  if (requiredChannelLink && typeof requiredChannelLink === "string") {
    const usernameFromLink = parseChannelUsernameFromLink(requiredChannelLink);
    if (usernameFromLink) {
      channelCandidates.push(usernameFromLink);
    }
  }

  const uniqueCandidates = [...new Set(channelCandidates)];

  for (const candidate of uniqueCandidates) {
    try {
      const member = await bot.getChatMember(candidate, telegramId);
      const allowed = ["creator", "administrator", "member", "restricted"];
      if (allowed.includes(member.status)) {
        return true;
      }
    } catch (_err) {
      continue;
    }
  }
  return false;
}

async function onStart(bot, msg) {
  await usage("/start");
  const existing = await getUserByTelegramId(msg.from.id);
  if (existing) {
    await bot.sendMessage(
      msg.chat.id,
      "Welcome back! Use /generate to create a new email or /id to list your emails."
    );
    return;
  }
 
  const args = parseArgs(msg.text);
  if (args[0]) {
    pendingReferralCode.set(msg.from.id, args[0]);
  }

  const startText = "Welcome! Do you want to create a new account or import an existing one?";
  await bot.sendMessage(msg.chat.id, startText, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Create Account", callback_data: "start_create_account" }],
        [{ text: "Import Private Address", callback_data: "start_import_account" }],
      ],
    },
  });
}

async function onStartCreateAccount(bot, query) {
  const telegramId = query.from.id;
  const existing = await getUserByTelegramId(telegramId);
  let user = existing;

  if (!user) {
    user = await ensureUser(telegramId);
    const code = pendingReferralCode.get(telegramId);
    if (code) {
      const referrer = await getUserByReferralCode(code);
      if (referrer && referrer.id !== user.id && !user.referred_by) {
        await setReferredBy(user.id, referrer.id);
        await addBalance(referrer.id, economy.referralRewardPoints, "referral_reward", `Referral signup: ${telegramId}`);
        user = await getUserByTelegramId(telegramId);
      }
    }
  }

  pendingReferralCode.delete(telegramId);

  await bot.sendMessage(
    query.message.chat.id,
    [
      "Account ready.",
      `Telegram ID: ${telegramId}`,
      `Private address: ${user.private_key}`,
      "Keep this private address safe. You can use it with /import to recover your account.",
    ].join("\n")
  );
}

async function onStartImportAccount(bot, query) {
  importPrivateKeyState.set(query.from.id, true);
  await bot.sendMessage(
    query.message.chat.id,
    "Send your private address now."
  );
}

async function handleImportPrivateKeyInput(bot, msg) {
  const waiting = importPrivateKeyState.get(msg.from.id);
  if (!waiting) {
    return false;
  }

  const privateKey = (msg.text || "").trim();
  if (!privateKey) {
    await bot.sendMessage(msg.chat.id, "Please send a valid private address or /cancel.");
    return true;
  }

  try {
    await importAccount(msg.from.id, privateKey);
    importPrivateKeyState.delete(msg.from.id);
    await bot.sendMessage(msg.chat.id, "Account import complete.");
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `Import failed: ${err.message}`);
  }

  return true;
}

async function onHelp(bot, msg) {
  await usage("/help");
  const helpText = [
    "Available commands:",
    "/mybal - Check points balance",
    "/deposit - Add points using Paytm",
    "/addbal <user_id> <points> - Add points (admin only)",
    "/redeem - Daily free points",
    "/generate [domain] - Create temporary email (costs points)",
    "/id - List your emails",
    "/mails <email> - View received mails for one email",
    "/webmail - Open web inbox UI",
    "/panel - Admin cPanel account manager",
    "/delete <email> - Delete owned email",
    "/accept <email> - Reclaim a deleted email",
    "/transfer <email> <user_id> - Transfer ownership",
    "/transfermailbynumber <index> <user_id> - Transfer by list number",
    "/bulktransfer - Start multi-transfer mode",
    "/share <email> <user_id> - Share read access",
    "/stopshare <email> - Remove all sharing access",
    "/myprivatekey - Show private key",
    "/import <private_key> - Recover account",
    "/viewreferral - Show referral stats",
    "/uses - Command usage stats",
    "/shop - Premium plans placeholder",
    "/cancel - Cancel active flow",
  ].join("\n");
  await bot.sendMessage(msg.chat.id, helpText);
}

async function onMyBal(bot, msg) {
  await usage("/mybal");
  const user = await ensureUser(msg.from.id);
  await bot.sendMessage(msg.chat.id, `Your balance: ${user.balance} points`);
}

async function onDeposit(bot, msg) {
  await usage("/deposit");
  const user = await ensureUser(msg.from.id);
  await startDepositFlow(bot, msg, user);
}

async function onAddBal(bot, msg) {
  await usage("/addbal");
  if (!isAdmin(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, "Admin only command.");
    return;
  }

  const args = parseArgs(msg.text);
  if (args.length < 2) {
    await bot.sendMessage(msg.chat.id, "Usage: /addbal <telegram_id> <points>");
    return;
  }

  const telegramId = Number(args[0]);
  const amount = Number(args[1]);
  if (!telegramId || !Number.isInteger(amount) || amount === 0) {
    await bot.sendMessage(msg.chat.id, "Invalid arguments.");
    return;
  }

  const target = await ensureUser(telegramId);
  await addBalance(target.id, amount, "admin_adjustment", `Admin adjustment by ${msg.from.id}`);
  await bot.sendMessage(msg.chat.id, `Added ${amount} points to ${telegramId}.`);
}

async function onRedeem(bot, msg) {
  await usage("/redeem");
  const user = await ensureUser(msg.from.id);

  const inChannel = await isUserInRequiredChannel(bot, msg.from.id);
  if (!inChannel) {
    const joinText = requiredChannelLink
      ? `Please join our channel first to redeem balance: ${requiredChannelLink}`
      : "Please join our channel first to redeem balance. For private channels, set REQUIRED_CHANNEL_ID to the numeric channel ID and add the bot to that channel.";

    const options = requiredChannelLink
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "Join Channel", url: requiredChannelLink }]],
          },
        }
      : undefined;

    await bot.sendMessage(msg.chat.id, joinText, options);
    return;
  }

  if (isToday(user.last_redeem_at)) {
    await bot.sendMessage(msg.chat.id, "You already redeemed today.");
    return;
  }

  await addBalance(user.id, economy.dailyRedeemPoints, "daily_redeem", "Daily reward");
  await updateLastRedeem(user.id, new Date().toISOString());
  await bot.sendMessage(msg.chat.id, `Redeemed ${economy.dailyRedeemPoints} points.`);
}

async function onGenerate(bot, msg) {
  await usage("/generate");
  const user = await ensureUser(msg.from.id);

  const args = parseArgs(msg.text);
  const requestedDomain = String(args[0] || "").trim().toLowerCase();

  if (requestedDomain) {
    try {
      const email = await generateEmailForUser(user, requestedDomain);
      await bot.sendMessage(
        msg.chat.id,
        `✅ *Email Generated*\n\nDomain: *${requestedDomain}*\nYour email: \`${email}\`\n\n_Use the button below to copy quickly._`,
        {
          parse_mode: "Markdown",
          reply_markup: copyEmailKeyboard(email),
        }
      );
    } catch (err) {
      await bot.sendMessage(msg.chat.id, err.message);
    }
    return;
  }

  const domains = await listGenerateDomains();
  if (!domains.length) {
    await bot.sendMessage(msg.chat.id, "No cPanel domain configured. Ask admin to add one in /panel.");
    return;
  }

  const options = domains.map((item, idx) => ({
    token: String(idx + 1),
    domain: item.domain,
  }));
  generateDomainState.set(msg.from.id, {
    createdAt: Date.now(),
    options,
  });

  await bot.sendMessage(
    msg.chat.id,
    "Select a domain to generate your email:",
    {
      reply_markup: buildGenerateDomainKeyboard(options),
    }
  );
}

async function onGenerateByDomainCallback(bot, query, token) {
  const state = generateDomainState.get(query.from.id);
  if (!state || Date.now() - state.createdAt > 10 * 60 * 1000) {
    generateDomainState.delete(query.from.id);
    await bot.sendMessage(query.message.chat.id, "Domain selection expired. Use /generate again.");
    return;
  }

  const selected = state.options.find((item) => item.token === token);
  if (!selected) {
    await bot.sendMessage(query.message.chat.id, "Invalid domain selected. Use /generate again.");
    return;
  }

  const user = await ensureUser(query.from.id);
  try {
    const email = await generateEmailForUser(user, selected.domain);
    generateDomainState.delete(query.from.id);
    await bot.sendMessage(
      query.message.chat.id,
      `✅ *Email Generated*\n\nDomain: *${selected.domain}*\nYour email: \`${email}\`\n\n_Use the button below to copy quickly._`,
      {
        parse_mode: "Markdown",
        reply_markup: copyEmailKeyboard(email),
      }
    );
  } catch (err) {
    await bot.sendMessage(query.message.chat.id, err.message);
  }
}

async function onId(bot, msg) {
  await usage("/id");
  const user = await ensureUser(msg.from.id);
  const emails = await listOwnedEmails(user.id);
  if (!emails.length) {
    await bot.sendMessage(msg.chat.id, "No emails found.");
    return;
  }

  const lines = ["📧 *Your Email List*", "_Tap a button to copy an email._", ""];
  for (const [idx, item] of emails.entries()) {
    lines.push(`${idx + 1}. \`${item.email}\` (${item.status})`);
  }

  await bot.sendMessage(msg.chat.id, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: copyEmailListKeyboard(emails),
  });
}

async function onMails(bot, msg) {
  await usage("/mails");
  const user = await ensureUser(msg.from.id);
  const args = parseArgs(msg.text);
  const inputEmail = (args[0] || "").trim().toLowerCase();
  if (!inputEmail) {
    await bot.sendMessage(msg.chat.id, "No email provided. Opening web inbox option instead.");
    await sendWebInboxButton(bot, msg.chat.id, msg.from.id);
    return;
  }

  try {
    const rows = await getReceivedMailsForUser(inputEmail, user.id, 10);
    if (!rows.length) {
      await bot.sendMessage(msg.chat.id, "No received mails found for this email yet.");
      return;
    }

    await bot.sendMessage(msg.chat.id, `Inbox for ${inputEmail} (latest ${rows.length})`);

    for (const [index, row] of rows.entries()) {
      const body = (row.body || "(empty)").slice(0, 350);
      const parts = [
        `${index + 1}) From: ${row.from_address || "unknown"}`,
        `Subject: ${row.subject || "(no subject)"}`,
        `Received: ${row.received_at || row.created_at}`,
        `Body: ${body}`,
      ];

      await bot.sendMessage(msg.chat.id, parts.join("\n"));
    }
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onWebmail(bot, msg) {
  await usage("/webmail");
  await ensureUser(msg.from.id);
  await sendWebInboxButton(bot, msg.chat.id, msg.from.id);
}

async function onPanel(bot, msg) {
  await usage("/panel");
  if (!isAdmin(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, "Admin only command.");
    return;
  }

  await showAdminPanel(bot, msg.chat.id);
}

async function handleAdminPanelInput(bot, msg) {
  const state = adminPanelState.get(msg.from.id);
  if (!state) {
    return false;
  }

  const text = (msg.text || "").trim();
  if (!text) {
    await bot.sendMessage(msg.chat.id, "Send account details or /cancel.");
    return true;
  }

  try {
    if (state.mode === "add_account") {
      const steps = getAdminPanelAddSteps();
      const currentStep = steps[state.stepIndex];

      if (!currentStep) {
        adminPanelState.delete(msg.from.id);
        return false;
      }

      if (state.stepIndex === 5) {
        const normalized = text.toLowerCase();
        if (!["yes", "no", "y", "n", "true", "false"].includes(normalized)) {
          await bot.sendMessage(msg.chat.id, "Please reply yes or no.");
          return true;
        }

        state.data.makeDefault = ["yes", "y", "true"].includes(normalized);
      } else {
        if (!text) {
          await bot.sendMessage(msg.chat.id, "This field cannot be empty.");
          return true;
        }

        state.data[currentStep.key] = text;
      }

      state.stepIndex += 1;

      if (state.stepIndex >= steps.length) {
        const account = await addCpanelAccount(state.data);
        adminPanelState.delete(msg.from.id);
        await bot.sendMessage(
          msg.chat.id,
          [
            "cPanel account added.",
            `ID: ${account.id}`,
            `Name: ${account.name}`,
            `Domains: ${(account.domains || [account.domain]).join(", ")}`,
          ].join("\n")
        );
        return true;
      }

      await promptNextAdminPanelStep(bot, msg.chat.id, state);
      return true;
    }

    if (state.mode === "delete_account") {
      const accountId = Number(text);
      if (!Number.isInteger(accountId) || accountId <= 0) {
        await bot.sendMessage(msg.chat.id, "Send a valid account ID.");
        return true;
      }

      const deleted = await deleteCpanelAccount(accountId);
      adminPanelState.delete(msg.from.id);
      await bot.sendMessage(msg.chat.id, `Deleted cPanel account: ${deleted.name}`);
      return true;
    }

    if (state.mode === "set_default_account") {
      const accountId = Number(text);
      if (!Number.isInteger(accountId) || accountId <= 0) {
        await bot.sendMessage(msg.chat.id, "Send a valid account ID.");
        return true;
      }

      await setDefaultCpanelAccount(accountId);
      adminPanelState.delete(msg.from.id);
      await bot.sendMessage(msg.chat.id, "Default cPanel account updated.");
      return true;
    }
  } catch (err) {
    adminPanelState.delete(msg.from.id);
    await bot.sendMessage(msg.chat.id, `Panel action failed: ${err.message}`);
    return true;
  }

  adminPanelState.delete(msg.from.id);
  return false;
}

async function onDelete(bot, msg) {
  await usage("/delete");
  const user = await ensureUser(msg.from.id);
  const args = parseArgs(msg.text);
  if (!args[0]) {
    await bot.sendMessage(msg.chat.id, "Usage: /delete <email>");
    return;
  }

  try {
    await deleteEmail(args[0], user.id);
    await bot.sendMessage(msg.chat.id, "Email deleted and now reclaimable.");
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onAccept(bot, msg) {
  await usage("/accept");
  const user = await ensureUser(msg.from.id);
  const args = parseArgs(msg.text);
  if (!args[0]) {
    await bot.sendMessage(msg.chat.id, "Usage: /accept <email>");
    return;
  }

  try {
    await acceptDeletedEmail(args[0], user.id);
    await bot.sendMessage(msg.chat.id, "Email claimed successfully.");
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onTransfer(bot, msg) {
  await usage("/transfer");
  const user = await ensureUser(msg.from.id);
  const args = parseArgs(msg.text);
  if (args.length < 2) {
    await bot.sendMessage(msg.chat.id, "Usage: /transfer <email> <user_id>");
    return;
  }

  const targetTelegramId = Number(args[1]);
  if (!targetTelegramId) {
    await bot.sendMessage(msg.chat.id, "Invalid user_id.");
    return;
  }

  const target = await ensureUser(targetTelegramId);
  try {
    await transferEmail(args[0], user.id, target.id);
    await bot.sendMessage(msg.chat.id, `Transferred ${args[0]} to ${targetTelegramId}.`);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onTransferByNumber(bot, msg) {
  await usage("/transfermailbynumber");
  const user = await ensureUser(msg.from.id);
  const args = parseArgs(msg.text);
  if (args.length < 2) {
    await bot.sendMessage(msg.chat.id, "Usage: /transfermailbynumber <index> <user_id>");
    return;
  }

  const index = Number(args[0]);
  const targetTelegramId = Number(args[1]);
  if (!Number.isInteger(index) || index <= 0 || !targetTelegramId) {
    await bot.sendMessage(msg.chat.id, "Invalid arguments.");
    return;
  }

  const target = await ensureUser(targetTelegramId);
  try {
    const email = await transferByIndex(user.id, index, target.id);
    await bot.sendMessage(msg.chat.id, `Transferred ${email} to ${targetTelegramId}.`);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onBulkTransfer(bot, msg) {
  await usage("/bulktransfer");
  const args = parseArgs(msg.text);
  if (args.length !== 1) {
    await bot.sendMessage(
      msg.chat.id,
      "Usage: /bulktransfer <target_user_id> then send one email per message. Use /cancel when done."
    );
    return;
  }

  const targetTelegramId = Number(args[0]);
  if (!targetTelegramId) {
    await bot.sendMessage(msg.chat.id, "Invalid target user id.");
    return;
  }

  bulkTransferState.set(msg.from.id, { targetTelegramId, moved: 0 });
  await ensureUser(targetTelegramId);
  await bot.sendMessage(msg.chat.id, "Bulk transfer mode enabled. Send email addresses line by line.");
}

async function handleBulkTransferInput(bot, msg) {
  const state = bulkTransferState.get(msg.from.id);
  if (!state) {
    return false;
  }

  const user = await ensureUser(msg.from.id);
  const target = await getUserByTelegramId(state.targetTelegramId);
  const email = (msg.text || "").trim().toLowerCase();

  if (!target || !email.includes("@")) {
    await bot.sendMessage(msg.chat.id, "Send a valid email address or /cancel.");
    return true;
  }

  try {
    await transferEmail(email, user.id, target.id);
    state.moved += 1;
    await bot.sendMessage(msg.chat.id, `Transferred: ${email}`);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `Failed for ${email}: ${err.message}`);
  }

  return true;
}

async function onShare(bot, msg) {
  await usage("/share");
  const user = await ensureUser(msg.from.id);
  const args = parseArgs(msg.text);
  if (args.length < 2) {
    await bot.sendMessage(msg.chat.id, "Usage: /share <email> <user_id>");
    return;
  }

  const targetTelegramId = Number(args[1]);
  if (!targetTelegramId) {
    await bot.sendMessage(msg.chat.id, "Invalid user id.");
    return;
  }

  const target = await ensureUser(targetTelegramId);
  try {
    await shareEmail(args[0], user.id, target.id);
    await bot.sendMessage(msg.chat.id, "Email shared.");
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onStopShare(bot, msg) {
  await usage("/stopshare");
  const user = await ensureUser(msg.from.id);
  const args = parseArgs(msg.text);
  if (!args[0]) {
    await bot.sendMessage(msg.chat.id, "Usage: /stopshare <email>");
    return;
  }

  try {
    await stopShareEmail(args[0], user.id);
    await bot.sendMessage(msg.chat.id, "Shared access removed.");
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onMyPrivateKey(bot, msg) {
  await usage("/myprivatekey");
  const user = await ensureUser(msg.from.id);
  await bot.sendMessage(msg.chat.id, `Your private key: ${user.private_key}`);
}

async function onImport(bot, msg) {
  await usage("/import");
  const args = parseArgs(msg.text);
  if (!args[0]) {
    await bot.sendMessage(msg.chat.id, "Usage: /import <private_key>");
    return;
  }

  try {
    await importAccount(msg.from.id, args[0]);
    await bot.sendMessage(msg.chat.id, "Account import complete.");
  } catch (err) {
    await bot.sendMessage(msg.chat.id, err.message);
  }
}

async function onViewReferral(bot, msg) {
  await usage("/viewreferral");
  const user = await ensureUser(msg.from.id);
  const stats = await getReferralStats(user.id);
  await bot.sendMessage(
    msg.chat.id,
    `Referrals: ${stats.totalReferrals}\nReferral earnings: ${stats.earnings} points\nYour code: ${user.referral_code}`
  );
}

async function onUses(bot, msg) {
  await usage("/uses");
  const top = await usageService.getTop(30);
  if (!top.length) {
    await bot.sendMessage(msg.chat.id, "No usage stats yet.");
    return;
  }

  const text = top.map((row) => `${row.command} -> ${row.total_count}`).join("\n");
  await bot.sendMessage(msg.chat.id, text);
}

async function onShop(bot, msg) {
  await usage("/shop");
  await bot.sendMessage(
    msg.chat.id,
    "Shop:\n1) 10 points pack\n2) Monthly premium\n3) Bulk email generation plan\n(Contact admin to purchase.)"
  );
}

async function onCancel(bot, msg) {
  await usage("/cancel");
  const isImportActive = importPrivateKeyState.get(msg.from.id);
  const state = bulkTransferState.get(msg.from.id);
  const isPanelActive = adminPanelState.get(msg.from.id);
  const hasGenerateSelection = generateDomainState.has(msg.from.id);
  const hasDeposit = depositIntervals.has(msg.chat.id);
  bulkTransferState.delete(msg.from.id);
  importPrivateKeyState.delete(msg.from.id);
  adminPanelState.delete(msg.from.id);
  pendingReferralCode.delete(msg.from.id);
  generateDomainState.delete(msg.from.id);
  if (hasDeposit) {
    const running = depositIntervals.get(msg.chat.id);
    const paymentId = running?.paymentId;
    stopDepositPolling(msg.chat.id);
    if (paymentId) {
      await markDepositStatus(paymentId, "cancelled", null, "Cancelled by user via /cancel");
    }
    await editDepositMessage(
      bot,
      msg.chat.id,
      running?.messageId,
      "🚫 *Payment process has been cancelled.*",
      {
        inline_keyboard: [[{ text: "New Deposit", callback_data: "deposit_restart" }]],
      }
    );
    return;
  }

  if (isImportActive) {
    await bot.sendMessage(msg.chat.id, "Import flow cancelled.");
    return;
  }

  if (state) {
    await bot.sendMessage(msg.chat.id, `Bulk transfer stopped. Moved ${state.moved} emails.`);
    return;
  }

  if (isPanelActive) {
    await bot.sendMessage(msg.chat.id, "Admin panel flow cancelled.");
    return;
  }

  if (hasGenerateSelection) {
    await bot.sendMessage(msg.chat.id, "Generate domain selection cancelled.");
    return;
  }

  await bot.sendMessage(msg.chat.id, "No active flow to cancel.");
}

function registerCommandHandlers(bot) {
  bot.onText(/^\/start(?:\s+.*)?$/i, (msg) => onStart(bot, msg));
  bot.onText(/^\/help$/i, (msg) => onHelp(bot, msg));
  bot.onText(/^\/mybal$/i, (msg) => onMyBal(bot, msg));
  bot.onText(/^\/deposit$/i, (msg) => onDeposit(bot, msg));
  bot.onText(/^\/addbal(?:\s+.*)?$/i, (msg) => onAddBal(bot, msg));
  bot.onText(/^\/redeem$/i, (msg) => onRedeem(bot, msg));
  bot.onText(/^\/generate(?:\s+.*)?$/i, (msg) => onGenerate(bot, msg));
  bot.onText(/^\/id$/i, (msg) => onId(bot, msg));
  bot.onText(/^\/mails(?:\s+.*)?$/i, (msg) => onMails(bot, msg));
  bot.onText(/^\/mail(?:\s+.*)?$/i, (msg) => onMails(bot, msg));
  bot.onText(/^\/webmail$/i, (msg) => onWebmail(bot, msg));
  bot.onText(/^\/panel$/i, (msg) => onPanel(bot, msg));
  bot.onText(/^\/delete(?:\s+.*)?$/i, (msg) => onDelete(bot, msg));
  bot.onText(/^\/accept(?:\s+.*)?$/i, (msg) => onAccept(bot, msg));
  bot.onText(/^\/transfer(?:\s+.*)?$/i, (msg) => onTransfer(bot, msg));
  bot.onText(/^\/bulktransfer(?:\s+.*)?$/i, (msg) => onBulkTransfer(bot, msg));
  bot.onText(/^\/transfermailbynumber(?:\s+.*)?$/i, (msg) => onTransferByNumber(bot, msg));
  bot.onText(/^\/share(?:\s+.*)?$/i, (msg) => onShare(bot, msg));
  bot.onText(/^\/stopshare(?:\s+.*)?$/i, (msg) => onStopShare(bot, msg));
  bot.onText(/^\/myprivatekey$/i, (msg) => onMyPrivateKey(bot, msg));
  bot.onText(/^\/import(?:\s+.*)?$/i, (msg) => onImport(bot, msg));
  bot.onText(/^\/viewreferral$/i, (msg) => onViewReferral(bot, msg));
  bot.onText(/^\/uses$/i, (msg) => onUses(bot, msg));
  bot.onText(/^\/shop$/i, (msg) => onShop(bot, msg));
  bot.onText(/^\/cancel$/i, (msg) => onCancel(bot, msg));

  bot.on("callback_query", async (query) => {
    let callbackAnswered = false;
    try {
      if (query.data === "start_create_account") {
        await usage("inline_create_account");
        await onStartCreateAccount(bot, query);
      } else if (query.data === "start_import_account") {
        await usage("inline_import_account");
        await onStartImportAccount(bot, query);
      } else if (query.data?.startsWith("generate_domain:")) {
        await usage("inline_generate_domain");
        const token = query.data.split(":")[1] || "";
        await onGenerateByDomainCallback(bot, query, token);
      } else if (query.data?.startsWith("deposit_cancel:")) {
        await usage("inline_deposit_cancel");
        const paymentId = query.data.split(":")[1];
        const running = depositIntervals.get(query.message.chat.id);
        if (running && running.paymentId === paymentId) {
          stopDepositPolling(query.message.chat.id);
          await markDepositStatus(paymentId, "cancelled", null, "Cancelled by user from inline button");
          await editDepositMessage(
            bot,
            query.message.chat.id,
            query.message.message_id,
            "🚫 *Payment process has been cancelled.*",
            {
              inline_keyboard: [[{ text: "New Deposit", callback_data: "deposit_restart" }]],
            }
          );
        } else {
          // Do not send extra chat message for stale callbacks.
        }
      } else if (query.data === "deposit_restart") {
        await usage("inline_deposit_restart");
        const user = await ensureUser(query.from.id);
        await startDepositFlow(bot, { chat: { id: query.message.chat.id } }, user);
      } else if (query.data === "panel_add_account") {
        if (!isAdmin(query.from.id)) {
          await bot.sendMessage(query.message.chat.id, "Admin only command.");
        } else {
          adminPanelState.set(query.from.id, { mode: "add_account", stepIndex: 0, data: {} });
          await promptNextAdminPanelStep(bot, query.message.chat.id, { stepIndex: 0, data: {} });
        }
      } else if (query.data === "panel_list_accounts") {
        if (!isAdmin(query.from.id)) {
          await bot.sendMessage(query.message.chat.id, "Admin only command.");
        } else {
          const accounts = await listCpanelAccounts();
          await bot.sendMessage(
            query.message.chat.id,
            formatAdminPanelAccounts(accounts) || "No cPanel accounts configured yet."
          );
        }
      } else if (query.data === "panel_delete_account") {
        if (!isAdmin(query.from.id)) {
          await bot.sendMessage(query.message.chat.id, "Admin only command.");
        } else {
          adminPanelState.set(query.from.id, { mode: "delete_account" });
          await bot.sendMessage(query.message.chat.id, "Send the account ID to delete.");
        }
      } else if (query.data === "panel_set_default_account") {
        if (!isAdmin(query.from.id)) {
          await bot.sendMessage(query.message.chat.id, "Admin only command.");
        } else {
          adminPanelState.set(query.from.id, { mode: "set_default_account" });
          await bot.sendMessage(query.message.chat.id, "Send the account ID to make default.");
        }
      } else if (query.data === "panel_close") {
        if (isAdmin(query.from.id)) {
          adminPanelState.delete(query.from.id);
        }
      }
    } catch (err) {
      await bot.sendMessage(query.message.chat.id, `Action failed: ${err.message}`);
    } finally {
      if (!callbackAnswered) {
        await bot.answerCallbackQuery(query.id);
      }
    }
  });

  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) {
      return;
    }

    const handledPanel = await handleAdminPanelInput(bot, msg);
    if (handledPanel) {
      return;
    }

    const handledImport = await handleImportPrivateKeyInput(bot, msg);
    if (handledImport) {
      return;
    }

    await handleBulkTransferInput(bot, msg);
  });
}

module.exports = {
  registerCommandHandlers,
};
