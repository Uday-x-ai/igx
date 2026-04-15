const { collection, nextSequence } = require("../data/db");
const { cpanel: legacyCpanel } = require("../config");

function normalize(value) {
  return String(value || "").trim();
}

function normalizeDomain(value) {
  return normalize(value).toLowerCase();
}

function splitDomains(input) {
  if (Array.isArray(input)) {
    const unique = new Set();
    for (const item of input) {
      const domain = normalizeDomain(item);
      if (domain) {
        unique.add(domain);
      }
    }
    return [...unique];
  }

  const text = normalize(input);
  if (!text) {
    return [];
  }

  const unique = new Set();
  for (const part of text.split(",")) {
    const domain = normalizeDomain(part);
    if (domain) {
      unique.add(domain);
    }
  }

  return [...unique];
}

function rowToAccount(row) {
  if (!row) {
    return null;
  }

  const domains = splitDomains(row.domains || row.domain);
  const domain = normalizeDomain(row.domain) || domains[0] || "";

  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    username: row.username,
    apiToken: row.api_token,
    domain,
    domains,
    status: row.status,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: "database",
  };
}

function getLegacyAccount() {
  const domains = splitDomains(legacyCpanel.domains || legacyCpanel.domain);
  const domain = normalizeDomain(legacyCpanel.domain) || domains[0] || "";
  if (!legacyCpanel.baseUrl || !legacyCpanel.username || !legacyCpanel.apiToken || !domain) {
    return null;
  }

  return {
    id: null,
    name: "Legacy config",
    baseUrl: legacyCpanel.baseUrl,
    username: legacyCpanel.username,
    apiToken: legacyCpanel.apiToken,
    domain,
    domains,
    status: "active",
    isDefault: true,
    createdAt: null,
    updatedAt: null,
    source: "env",
  };
}

async function listCpanelAccounts() {
  const rows = await collection("cpanel_accounts")
    .find({}, { projection: { _id: 0 } })
    .sort({ is_default: -1, id: 1 })
    .toArray();
  const accounts = rows.map(rowToAccount).filter(Boolean);
  if (!accounts.length) {
    const legacy = getLegacyAccount();
    return legacy ? [legacy] : [];
  }
  return accounts;
}

async function listEnabledCpanelAccounts() {
  const rows = await collection("cpanel_accounts")
    .find({ status: "active" }, { projection: { _id: 0 } })
    .sort({ is_default: -1, id: 1 })
    .toArray();
  const accounts = rows.map(rowToAccount).filter(Boolean);
  if (!accounts.length) {
    const legacy = getLegacyAccount();
    return legacy ? [legacy] : [];
  }
  return accounts;
}

async function getCpanelAccountById(accountId) {
  if (accountId === null || accountId === undefined) {
    return getLegacyAccount();
  }

  const row = await collection("cpanel_accounts").findOne({ id: accountId }, { projection: { _id: 0 } });
  return rowToAccount(row);
}

async function getCpanelAccountForEmailRow(emailRow) {
  if (!emailRow) {
    return getLegacyAccount();
  }

  return getCpanelAccountById(emailRow.cpanel_account_id);
}

async function getNextCpanelAccount() {
  const accounts = await listEnabledCpanelAccounts();
  if (!accounts.length) {
    return null;
  }

  if (!getNextCpanelAccount._cursor) {
    getNextCpanelAccount._cursor = 0;
  }

  const account = accounts[getNextCpanelAccount._cursor % accounts.length];
  getNextCpanelAccount._cursor = (getNextCpanelAccount._cursor + 1) % accounts.length;
  return account;
}

async function getNextCpanelAccountForDomain(domain) {
  const requested = normalizeDomain(domain);
  if (!requested) {
    return getNextCpanelAccount();
  }

  const accounts = await listEnabledCpanelAccounts();
  const matching = accounts.filter((account) => {
    const domains = splitDomains(account.domains || account.domain);
    return domains.includes(requested);
  });

  if (!matching.length) {
    return null;
  }

  if (!getNextCpanelAccountForDomain._cursorByDomain) {
    getNextCpanelAccountForDomain._cursorByDomain = new Map();
  }

  const cursorByDomain = getNextCpanelAccountForDomain._cursorByDomain;
  const current = cursorByDomain.get(requested) || 0;
  const account = matching[current % matching.length];
  cursorByDomain.set(requested, (current + 1) % matching.length);
  return account;
}

async function listGenerateDomains() {
  const accounts = await listEnabledCpanelAccounts();
  const byDomain = new Map();

  for (const account of accounts) {
    const domains = splitDomains(account.domains || account.domain);
    for (const domain of domains) {
      if (!byDomain.has(domain)) {
        byDomain.set(domain, []);
      }
      byDomain.get(domain).push(account);
    }
  }

  return [...byDomain.entries()]
    .map(([domain, matchedAccounts]) => ({
      domain,
      accountCount: matchedAccounts.length,
      isDefault: matchedAccounts.some((account) => account.isDefault),
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return a.domain.localeCompare(b.domain);
    });
}

async function addCpanelAccount(input) {
  const name = normalize(input.name);
  const baseUrl = normalize(input.baseUrl);
  const username = normalize(input.username);
  const apiToken = normalize(input.apiToken);
  const domains = splitDomains(input.domains || input.domain);
  const domain = domains[0] || "";

  if (!name || !baseUrl || !username || !apiToken || !domain) {
    throw new Error("All fields are required: name, baseUrl, username, apiToken, domains.");
  }

  const id = await nextSequence("cpanel_accounts");
  await collection("cpanel_accounts").insertOne({
    id,
    name,
    base_url: baseUrl,
    username,
    api_token: apiToken,
    domain,
    domains,
    status: "active",
    is_default: input.isDefault ? 1 : 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (input.makeDefault) {
    await setDefaultCpanelAccount(id);
  }

  return getCpanelAccountById(id);
}

async function setDefaultCpanelAccount(accountId) {
  await collection("cpanel_accounts").updateMany({}, { $set: { is_default: 0 } });
  await collection("cpanel_accounts").updateOne(
    { id: accountId },
    { $set: { is_default: 1, updated_at: new Date().toISOString() } }
  );
}

async function deleteCpanelAccount(accountId) {
  const account = await getCpanelAccountById(accountId);
  if (!account || account.source !== "database") {
    throw new Error("CPanel account not found.");
  }

  await collection("cpanel_accounts").deleteOne({ id: accountId });
  return account;
}

module.exports = {
  addCpanelAccount,
  deleteCpanelAccount,
  getCpanelAccountById,
  getCpanelAccountForEmailRow,
  getLegacyAccount,
  getNextCpanelAccount,
  getNextCpanelAccountForDomain,
  listCpanelAccounts,
  listGenerateDomains,
  listEnabledCpanelAccounts,
  setDefaultCpanelAccount,
};
