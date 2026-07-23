"use strict";

const crypto = require("crypto");
const {promisify} = require("util");
const webpush = require("web-push");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {FieldValue, getFirestore} = require("firebase-admin/firestore");
const {getStorage} = require("firebase-admin/storage");
const {defineSecret} = require("firebase-functions/params");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {HttpsError, onCall} = require("firebase-functions/v2/https");

initializeApp();
setGlobalOptions({
  region: "asia-northeast3",
  memory: "256MiB",
  timeoutSeconds: 60,
  maxInstances: 10,
});

const db = getFirestore();
const auth = getAuth();
const scryptAsync = promisify(crypto.scrypt);
const RECOVERY_EMAIL = "twd412412@gmail.com";
const ACCOUNT_PIN_PATTERN = /^\d{4}$/;
const HASH_VERSION = "scrypt-v1";
const ELEVATION_MS = 4 * 60 * 60 * 1000;
const SONG_INDEX_SHARDS = 16;
const MAX_SAME_NAME_ACCOUNTS = 12;
const WEB_PUSH_PUBLIC_KEY = "BP86C82vcDoE_quMY8q6mUDNmrfMyHQMXfTeM7DPuxqRlq-newKbPf_bRb84fZEHdUiGQjMaE72ByhAV34Qw5qY";
const WEB_PUSH_PRIVATE_KEY = defineSecret("WEB_PUSH_PRIVATE_KEY");
const ACCOUNT_PIN_ENCRYPTION_KEY = defineSecret("ACCOUNT_PIN_ENCRYPTION_KEY");
const WEB_PUSH_SUBJECT = "mailto:twd412412@gmail.com";
const APP_URL = "https://twd412412-ux.github.io/260410choir_program/";
const ACCOUNT_PIN_CIPHER_VERSION = "aes-256-gcm-v1";
const ACCOUNT_PIN_DIRECTORY_ID = "account-pin-directory";
const ALLOWED_SCORE_SCOPES = new Set(["default", "all", "singer", "orchestra", "none"]);
const ARCHIVE_REACTION_TYPES = new Set([
  "heart", "grace", "cheer", "thanks", "celebrate", "surprise", "awkward", "tricky",
]);
const ALLOWED_PERMISSIONS = new Set([
  "song.manage", "song.editAny", "score.manage", "score.editAny",
  "schedule.manage", "schedule.editAny", "attendance.view", "attendance.check",
  "attendance.delete", "member.view", "member.history", "member.manage",
  "member.delete", "account.manage", "account.pin", "archive.upload",
  "archive.manageMine", "archive.organize", "notice.manage", "song.recommend",
  "seating.manage",
]);
const PRESET_PERMISSIONS = {
  none: [],
  partLeader: ["attendance.view", "attendance.check", "archive.upload", "archive.manageMine"],
  operations: ["song.manage", "score.manage", "score.editAny", "schedule.manage", "song.recommend", "archive.upload", "archive.manageMine", "archive.organize"],
  chongmu: ["song.manage", "score.manage", "score.editAny", "schedule.manage", "attendance.view", "attendance.check", "member.view", "member.history", "notice.manage", "archive.upload", "archive.manageMine", "archive.organize"],
  handbook: ["member.view", "member.history", "member.manage"],
};
const LEGACY_PERMISSIONS = {
  attendance: ["attendance.view", "attendance.check", "archive.upload", "archive.manageMine"],
  songschedule: ["song.manage", "score.manage", "score.editAny", "schedule.manage", "archive.upload", "archive.manageMine", "archive.organize"],
  chongmu: PRESET_PERMISSIONS.chongmu,
};

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeName(value) {
  let text = cleanString(value, 80);
  if (text.normalize) text = text.normalize("NFKC");
  return text.replace(/\s+/g, "").toLowerCase();
}

function isValidDocumentId(value) {
  const id = cleanString(value, 1500);
  return Boolean(id && id !== "." && id !== ".." && !id.includes("/") && !/^__.*__$/.test(id));
}

function uniqueAllowed(values, allowedSet, maxItems = 40) {
  const out = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const item = cleanString(value, 80);
    if (item && (!allowedSet || allowedSet.has(item)) && !out.includes(item) && out.length < maxItems) out.push(item);
  });
  return out;
}

function accountPermissions(data) {
  const stored = uniqueAllowed(data.permissions, ALLOWED_PERMISSIONS);
  const preset = cleanString(data.permissionPreset, 30);
  const legacy = LEGACY_PERMISSIONS[cleanString(data.role, 30)] || [];
  const presetRows = PRESET_PERMISSIONS[preset] || [];
  const combined = (stored.length ? stored : (presetRows.length ? presetRows : legacy)).slice();
  if (data.canArchiveUpload) combined.push("archive.upload", "archive.manageMine");
  return uniqueAllowed(combined, ALLOWED_PERMISSIONS);
}

function normalizeAttendanceScope(values) {
  const allowed = new Set(["ALL", "S1", "S2", "T1", "T2", "관현악", "지휘", "반주", "임원"]);
  return uniqueAllowed(values, allowed, 16);
}

function normalizeScorePartPreferences(values) {
  const out = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const part = cleanString(value, 80).replace(/\s+/g, " ");
    if (part && !out.includes(part) && out.length < 8) out.push(part);
  });
  return out;
}

function accountClaims(account) {
  const scoreScope = cleanString(account.scoreAccessScope, 20) || "default";
  return {
    account: true,
    choirName: cleanString(account.name, 60),
    choirPart: cleanString(account.part, 30),
    memberId: cleanString(account.memberId, 80),
    role: cleanString(account.role, 30),
    permissionPreset: cleanString(account.permissionPreset, 30),
    permissions: accountPermissions(account),
    attendanceScope: normalizeAttendanceScope(account.attendanceScope),
    scoreAccessScope: ALLOWED_SCORE_SCOPES.has(scoreScope) ? scoreScope : "default",
  };
}

function safeProfile(id, account) {
  return {
    id,
    name: cleanString(account.name, 60),
    part: cleanString(account.part, 30),
    pinSet: account.pinSet !== false,
    memberId: cleanString(account.memberId, 80),
    role: cleanString(account.role, 30),
    canArchiveUpload: Boolean(account.canArchiveUpload),
    permissionPreset: cleanString(account.permissionPreset, 30),
    permissions: accountPermissions(account),
    attendanceScope: normalizeAttendanceScope(account.attendanceScope),
    scoreAccessScope: ALLOWED_SCORE_SCOPES.has(account.scoreAccessScope) ? account.scoreAccessScope : "default",
    scorePartPreferences: normalizeScorePartPreferences(account.scorePartPreferences),
    favorites: Array.isArray(account.favorites) ? account.favorites.slice(0, 1000) : [],
  };
}

function isElevationValid(token, role) {
  if (!token) return false;
  const until = Number(token.elevatedUntil || 0);
  if (!until || until <= Date.now()) return false;
  if (role === "admin") return token.admin === true;
  return token.legacyRole === role;
}

function isAdminRequest(request) {
  return Boolean(request.auth && isElevationValid(request.auth.token, "admin"));
}

function requestPermissions(request) {
  if (!request.auth) return [];
  return uniqueAllowed(request.auth.token.permissions, ALLOWED_PERMISSIONS);
}

function hasPermission(request, permission) {
  return isAdminRequest(request) || requestPermissions(request).includes(permission);
}

function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
}

function requirePermission(request, permission) {
  requireAuth(request);
  if (!hasPermission(request, permission)) throw new HttpsError("permission-denied", "권한이 없습니다.");
}

function requireAdmin(request) {
  requireAuth(request);
  if (!isAdminRequest(request)) throw new HttpsError("permission-denied", "관리자 권한이 필요합니다.");
}

function isRecoveryRequest(request) {
  return Boolean(request.auth && cleanString(request.auth.token.email, 200).toLowerCase() === RECOVERY_EMAIL && request.auth.token.email_verified === true);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(password), salt, 64, {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return {hashVersion: HASH_VERSION, salt: salt.toString("base64"), hash: Buffer.from(derived).toString("base64"), updatedAt: nowIso()};
}

async function verifyPassword(password, secret) {
  if (!secret) return false;
  if (secret.hashVersion === HASH_VERSION && secret.salt && secret.hash) {
    const salt = Buffer.from(secret.salt, "base64");
    const expected = Buffer.from(secret.hash, "base64");
    const actual = Buffer.from(await scryptAsync(String(password), salt, expected.length, {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024}));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  if (secret.hashVersion === "legacy-sha256" && secret.salt && secret.hash) {
    const actual = crypto.createHash("sha256").update(String(secret.salt) + ":" + String(password)).digest("hex");
    const expected = String(secret.hash);
    return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }
  return false;
}

function accountPinEncryptionKey() {
  const key = Buffer.from(cleanString(ACCOUNT_PIN_ENCRYPTION_KEY.value(), 200), "base64");
  if (key.length !== 32) throw new Error("account_pin_encryption_key_invalid");
  return key;
}

function accountPinCipherAad(accountId) {
  return Buffer.from("account-pin:" + accountId + ":" + ACCOUNT_PIN_CIPHER_VERSION, "utf8");
}

function encryptAccountPin(accountId, pin) {
  if (!isValidDocumentId(accountId) || !ACCOUNT_PIN_PATTERN.test(pin)) throw new Error("account_pin_encrypt_input_invalid");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", accountPinEncryptionKey(), iv);
  cipher.setAAD(accountPinCipherAad(accountId));
  const encrypted = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
  return {
    pinCipherVersion: ACCOUNT_PIN_CIPHER_VERSION,
    pinCiphertext: encrypted.toString("base64"),
    pinCipherIv: iv.toString("base64"),
    pinCipherTag: cipher.getAuthTag().toString("base64"),
    pinEncryptedAt: nowIso(),
  };
}

function decryptAccountPin(accountId, secret) {
  if (!secret || secret.pinCipherVersion !== ACCOUNT_PIN_CIPHER_VERSION) return "";
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      accountPinEncryptionKey(),
      Buffer.from(cleanString(secret.pinCipherIv, 100), "base64"),
    );
    decipher.setAAD(accountPinCipherAad(accountId));
    decipher.setAuthTag(Buffer.from(cleanString(secret.pinCipherTag, 100), "base64"));
    const pin = Buffer.concat([
      decipher.update(Buffer.from(cleanString(secret.pinCiphertext, 100), "base64")),
      decipher.final(),
    ]).toString("utf8");
    return ACCOUNT_PIN_PATTERN.test(pin) ? pin : "";
  } catch (error) {
    return "";
  }
}

async function buildAccountPinSecret(accountId, pin) {
  const hashed = await hashPassword(pin);
  return Object.assign({kind: "account", accountId}, hashed, encryptAccountPin(accountId, pin));
}

function accountPinDirectoryRef() {
  return db.collection("authSecrets").doc(ACCOUNT_PIN_DIRECTORY_ID);
}

function accountPinDirectoryEntry(secret) {
  return {
    pinCipherVersion: cleanString(secret && secret.pinCipherVersion, 40),
    pinCiphertext: cleanString(secret && secret.pinCiphertext, 100),
    pinCipherIv: cleanString(secret && secret.pinCipherIv, 100),
    pinCipherTag: cleanString(secret && secret.pinCipherTag, 100),
    pinEncryptedAt: cleanString(secret && secret.pinEncryptedAt, 60),
  };
}

function setAccountPinDirectoryEntries(batch, secretsByAccountId) {
  const pins = {};
  Object.keys(secretsByAccountId || {}).forEach((accountId) => {
    if (!isValidDocumentId(accountId)) return;
    pins[accountId] = accountPinDirectoryEntry(secretsByAccountId[accountId]);
  });
  if (!Object.keys(pins).length) return;
  batch.set(accountPinDirectoryRef(), {
    kind: "account-pin-directory",
    pins,
    updatedAt: nowIso(),
  }, {merge: true});
}

function deleteAccountPinDirectoryEntry(batch, accountId) {
  const pins = {};
  pins[accountId] = FieldValue.delete();
  batch.set(accountPinDirectoryRef(), {
    kind: "account-pin-directory",
    pins,
    updatedAt: nowIso(),
  }, {merge: true});
}

async function ensureAuthUser(uid, displayName) {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") {
      return auth.createUser({uid, displayName: cleanString(displayName, 60) || undefined});
    }
    throw error;
  }
}

async function setClaimsAndCreateToken(uid, claims, displayName) {
  await ensureAuthUser(uid, displayName);
  await auth.setCustomUserClaims(uid, claims);
  return auth.createCustomToken(uid, claims);
}

async function syncExistingAccountClaims(accountId, account) {
  try {
    await auth.getUser(accountId);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") return;
    throw error;
  }
  await auth.setCustomUserClaims(accountId, accountClaims(account));
}

function rateKey(kind, value) {
  return crypto.createHash("sha256").update(kind + ":" + String(value || "unknown")).digest("hex");
}

function requestIp(request) {
  const forwarded = cleanString(request.rawRequest && request.rawRequest.headers && request.rawRequest.headers["x-forwarded-for"], 200);
  return (forwarded.split(",")[0] || cleanString(request.rawRequest && request.rawRequest.ip, 100) || "unknown").trim();
}

async function assertRateAllowed(keys) {
  const refs = keys.map((key) => db.collection("securityRateLimits").doc(key));
  const snaps = await db.getAll(...refs);
  const now = Date.now();
  snaps.forEach((snap) => {
    const data = snap.exists ? snap.data() : {};
    if (Number(data.lockedUntil || 0) > now) throw new HttpsError("resource-exhausted", "잠시 후 다시 시도해주세요.");
  });
}

async function recordRateFailure(keys, limit, lockMs) {
  const now = Date.now();
  await Promise.all(keys.map((key) => {
    const ref = db.collection("securityRateLimits").doc(key);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const old = snap.exists ? snap.data() : {};
      const windowStart = Number(old.windowStart || 0);
      const inWindow = now - windowStart < 10 * 60 * 1000;
      const failures = (inWindow ? Number(old.failures || 0) : 0) + 1;
      tx.set(ref, {
        failures,
        windowStart: inWindow ? windowStart : now,
        lockedUntil: failures >= limit ? now + lockMs : 0,
        updatedAt: nowIso(),
      });
    });
  }));
}

async function clearRateFailures(keys) {
  const snaps = await db.getAll(...keys.map((key) => db.collection("securityRateLimits").doc(key)));
  const batch = db.batch();
  let changed = false;
  snaps.forEach((snap) => {
    if (snap.exists) {
      batch.delete(snap.ref);
      changed = true;
    }
  });
  if (changed) await batch.commit();
}

async function accountForName(name) {
  const nameKey = normalizeName(name);
  if (!nameKey) return {nameKey, rows: []};
  let snap = await db.collection("accounts").where("nameKey", "==", nameKey).limit(MAX_SAME_NAME_ACCOUNTS).get();
  if (snap.empty) snap = await db.collection("accounts").where("name", "==", cleanString(name, 60)).limit(MAX_SAME_NAME_ACCOUNTS).get();
  return {nameKey, rows: snap.docs};
}

async function accountSecret(accountDoc) {
  const ref = db.collection("authSecrets").doc(accountDoc.id);
  const secretSnap = await ref.get();
  if (secretSnap.exists) return {ref, secret: secretSnap.data(), legacyPin: ""};
  const account = accountDoc.data() || {};
  return {ref, secret: null, legacyPin: cleanString(account.pin, 20)};
}

async function accountPinMatch(accountDoc, pin) {
  const secretInfo = await accountSecret(accountDoc);
  const valid = secretInfo.secret
    ? await verifyPassword(pin, secretInfo.secret)
    : Boolean(secretInfo.legacyPin && secretInfo.legacyPin === pin);
  return {accountDoc, secretInfo, valid};
}

async function sameNameAccountRows(nameKey) {
  if (!nameKey) return [];
  const snap = await db.collection("accounts").where("nameKey", "==", nameKey).limit(MAX_SAME_NAME_ACCOUNTS).get();
  return snap.docs;
}

async function assertPinAvailableForName(nameKey, pin, excludeId, knownRows) {
  const rows = (knownRows || await sameNameAccountRows(nameKey)).filter((doc) => doc.id !== excludeId);
  if (!rows.length) return;
  const checks = await mapLimit(rows, 4, (doc) => accountPinMatch(doc, pin));
  if (checks.some((check) => check.valid)) {
    throw new HttpsError("already-exists", "동명이인은 서로 다른 PIN을 사용해야 합니다.");
  }
}

async function assertMemberLinkValid(memberId, accountName, excludeAccountId) {
  if (!memberId) return;
  const [memberSnap, linkedSnap] = await Promise.all([
    db.collection("members").doc(memberId).get(),
    db.collection("accounts").where("memberId", "==", memberId).limit(2).get(),
  ]);
  if (!memberSnap.exists) throw new HttpsError("not-found", "연결할 단원 명부를 찾을 수 없습니다.");
  if (normalizeName((memberSnap.data() || {}).name) !== normalizeName(accountName)) {
    throw new HttpsError("invalid-argument", "계정 이름과 명부 이름이 같아야 연결할 수 있습니다.");
  }
  if (linkedSnap.docs.some((doc) => doc.id !== excludeAccountId)) {
    throw new HttpsError("already-exists", "해당 단원 명부는 이미 다른 계정에 연결되어 있습니다.");
  }
}

async function replacementPinForNameChange(oldNameKey, newNameKey, accountId, pin) {
  if (!newNameKey || oldNameKey === newNameKey) return null;
  const rows = await sameNameAccountRows(newNameKey);
  const duplicates = rows.filter((doc) => doc.id !== accountId);
  if (!duplicates.length) return null;
  if (!ACCOUNT_PIN_PATTERN.test(pin)) {
    throw new HttpsError("invalid-argument", "동명이인 이름으로 변경할 때는 새 PIN 4자리가 필요합니다.");
  }
  await assertPinAvailableForName(newNameKey, pin, accountId, duplicates);
  return buildAccountPinSecret(accountId, pin);
}

async function loginWithPin(request) {
  const name = cleanString(request.data && request.data.name, 60);
  const pin = cleanString(request.data && request.data.pin, 12);
  if (!name || !ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "이름과 PIN 4자리를 확인해주세요.");
  const found = await accountForName(name);
  const rateKeys = [rateKey("account", found.nameKey), rateKey("ip", requestIp(request))];
  await assertRateAllowed(rateKeys);
  if (!found.rows.length) {
    await recordRateFailure(rateKeys, 8, 10 * 60 * 1000);
    throw new HttpsError("invalid-argument", "이름 또는 PIN을 확인해주세요.");
  }
  const checks = await mapLimit(found.rows, 4, (doc) => accountPinMatch(doc, pin));
  const matched = checks.filter((check) => check.valid);
  if (matched.length !== 1) {
    await recordRateFailure(rateKeys, 8, 10 * 60 * 1000);
    const message = matched.length > 1
      ? "계정을 구분할 수 없습니다. 관리자에게 PIN 변경을 요청해주세요."
      : "이름 또는 PIN을 확인해주세요.";
    throw new HttpsError("invalid-argument", message);
  }
  const accountDoc = matched[0].accountDoc;
  const account = accountDoc.data() || {};
  const secretInfo = matched[0].secretInfo;
  if (!secretInfo.secret) {
    const hashed = await buildAccountPinSecret(accountDoc.id, pin);
    const batch = db.batch();
    batch.set(secretInfo.ref, hashed);
    setAccountPinDirectoryEntries(batch, {[accountDoc.id]: hashed});
    batch.update(accountDoc.ref, {pin: FieldValue.delete(), pinSet: true, nameKey: found.nameKey, securityMigratedAt: nowIso()});
    await batch.commit();
  } else if (account.nameKey !== found.nameKey || account.pin) {
    await accountDoc.ref.update({pin: FieldValue.delete(), pinSet: true, nameKey: found.nameKey});
  }
  await clearRateFailures(rateKeys);
  const claims = accountClaims(account);
  const token = await setClaimsAndCreateToken(accountDoc.id, claims, account.name);
  return {token, profile: safeProfile(accountDoc.id, account)};
}

async function legacySecret(role) {
  const id = "legacy-" + role;
  const ref = db.collection("authSecrets").doc(id);
  const snap = await ref.get();
  if (snap.exists) return {id, ref, secret: snap.data()};
  const settings = await db.collection("settings").doc("admin").get();
  const data = settings.exists ? settings.data() : {};
  if (role === "admin" && data.adminPasswordHash && data.adminPasswordSalt) {
    return {id, ref, secret: {hashVersion: "legacy-sha256", hash: String(data.adminPasswordHash), salt: String(data.adminPasswordSalt)}, settingsRef: settings.ref};
  }
  if (role === "chongmu" && data.chongmuPassword) {
    return {id, ref, secret: null, legacyPassword: String(data.chongmuPassword), settingsRef: settings.ref};
  }
  return {id, ref, secret: null};
}

async function baseClaimsForUid(uid) {
  const accountSnap = await db.collection("accounts").doc(uid).get();
  if (!accountSnap.exists) return {claims: {}, profile: null};
  const account = accountSnap.data() || {};
  return {claims: accountClaims(account), profile: safeProfile(uid, account), displayName: account.name};
}

async function loginLegacyRole(request) {
  const role = cleanString(request.data && request.data.role, 20);
  const password = cleanString(request.data && request.data.password, 100);
  if (!password || !["admin", "chongmu"].includes(role)) throw new HttpsError("invalid-argument", "로그인 정보를 확인해주세요.");
  const rateKeys = [rateKey("legacy", role), rateKey("ip", requestIp(request))];
  await assertRateAllowed(rateKeys);
  const stored = await legacySecret(role);
  let valid = stored.secret ? await verifyPassword(password, stored.secret) : stored.legacyPassword === password;
  if (!valid) {
    await recordRateFailure(rateKeys, 5, 15 * 60 * 1000);
    throw new HttpsError("invalid-argument", "비밀번호를 확인해주세요.");
  }
  if (!stored.secret || stored.secret.hashVersion !== HASH_VERSION) {
    const hashed = await hashPassword(password);
    const batch = db.batch();
    batch.set(stored.ref, Object.assign({kind: "legacy", role}, hashed));
    if (stored.settingsRef) {
      const update = role === "admin"
        ? {adminPasswordHash: FieldValue.delete(), adminPasswordSalt: FieldValue.delete(), securityMigratedAt: nowIso()}
        : {chongmuPassword: FieldValue.delete(), securityMigratedAt: nowIso()};
      batch.update(stored.settingsRef, update);
    }
    await batch.commit();
  }
  await clearRateFailures(rateKeys);
  const accountUid = request.auth && request.auth.token.account ? request.auth.uid : "legacy-" + role;
  const base = await baseClaimsForUid(accountUid);
  const elevatedUntil = Date.now() + ELEVATION_MS;
  const claims = Object.assign({}, base.claims, {elevatedUntil});
  if (role === "admin") claims.admin = true;
  else {
    claims.legacyRole = "chongmu";
    claims.permissions = uniqueAllowed((claims.permissions || []).concat(LEGACY_PERMISSIONS.chongmu), ALLOWED_PERMISSIONS);
    claims.attendanceScope = ["ALL"];
    claims.scoreAccessScope = "all";
  }
  const token = await setClaimsAndCreateToken(accountUid, claims, base.displayName || (role === "admin" ? "관리자" : "총무부"));
  return {token, role, elevatedUntil, profile: base.profile};
}

async function endElevatedSession(request) {
  requireAuth(request);
  const uid = request.auth.uid;
  const base = await baseClaimsForUid(uid);
  if (!base.profile) {
    await auth.setCustomUserClaims(uid, {});
    await auth.revokeRefreshTokens(uid);
    return {signOut: true};
  }
  const token = await setClaimsAndCreateToken(uid, base.claims, base.displayName);
  return {signOut: false, token, profile: base.profile};
}

async function resetLegacyPassword(request) {
  requireAuth(request);
  const role = cleanString(request.data && request.data.role, 20);
  const password = cleanString(request.data && request.data.password, 100);
  if (!["admin", "chongmu"].includes(role) || password.length < 4) throw new HttpsError("invalid-argument", "비밀번호는 4자리 이상이어야 합니다.");
  if (role === "admin") {
    if (!isAdminRequest(request) && !isRecoveryRequest(request)) throw new HttpsError("permission-denied", "관리자 또는 복구 계정 인증이 필요합니다.");
  } else {
    requireAdmin(request);
  }
  const hashed = await hashPassword(password);
  const secretRef = db.collection("authSecrets").doc("legacy-" + role);
  const settingsRef = db.collection("settings").doc("admin");
  const batch = db.batch();
  batch.set(secretRef, Object.assign({kind: "legacy", role}, hashed));
  batch.set(settingsRef, role === "admin"
    ? {adminPasswordHash: FieldValue.delete(), adminPasswordSalt: FieldValue.delete(), adminPasswordUpdatedAt: nowIso(), updatedAt: nowIso()}
    : {chongmuPassword: FieldValue.delete(), chongmuPasswordUpdatedAt: nowIso(), updatedAt: nowIso()}, {merge: true});
  await batch.commit();
  return {ok: true};
}

function accountCreateData(input, actor) {
  const name = cleanString(input.name, 60);
  const part = cleanString(input.part, 30);
  const memberId = cleanString(input.memberId, 80);
  if (!name || !part) throw new HttpsError("invalid-argument", "이름과 파트는 필수입니다.");
  if (memberId && !isValidDocumentId(memberId)) throw new HttpsError("invalid-argument", "연결할 단원 명부 정보가 올바르지 않습니다.");
  return {
    name,
    nameKey: normalizeName(name),
    part,
    memberId,
    scoreAccessScope: "default",
    scorePartPreferences: [],
    favorites: [],
    pinSet: true,
    createdAt: nowIso(),
    createdBy: actor,
    memberLinkedAt: memberId ? nowIso() : "",
    memberLinkedBy: memberId ? actor : "",
  };
}

async function adminCreateAccount(request) {
  requirePermission(request, "account.manage");
  const pin = cleanString(request.data && request.data.pin, 12);
  if (!ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리여야 합니다.");
  const data = accountCreateData(request.data || {}, cleanString(request.auth.token.choirName, 60) || "관리자");
  const sameNameRows = await sameNameAccountRows(data.nameKey);
  await Promise.all([
    assertPinAvailableForName(data.nameKey, pin, "", sameNameRows),
    assertMemberLinkValid(data.memberId, data.name, ""),
  ]);
  const ref = db.collection("accounts").doc();
  const secret = await buildAccountPinSecret(ref.id, pin);
  const batch = db.batch();
  batch.set(ref, data);
  batch.set(db.collection("authSecrets").doc(ref.id), secret);
  setAccountPinDirectoryEntries(batch, {[ref.id]: secret});
  await batch.commit();
  return {account: safeProfile(ref.id, data)};
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return result;
}

function pushSubscriptionFromData(data) {
  const subscription = data && data.subscription || {};
  const keys = subscription.keys || {};
  const endpoint = cleanString(subscription.endpoint, 4096);
  const authKey = cleanString(keys.auth, 512);
  const p256dh = cleanString(keys.p256dh, 512);
  if (!endpoint || !authKey || !p256dh) return null;
  return {endpoint, keys: {auth: authKey, p256dh}};
}

async function claimPushEvent(eventId, type) {
  const id = crypto.createHash("sha256").update(String(eventId || "")).digest("hex");
  if (!id) return false;
  try {
    await db.collection("pushDeliveryEvents").doc(id).create({type, createdAt: nowIso()});
    return true;
  } catch (error) {
    if (error && (error.code === 6 || error.code === "already-exists")) return false;
    throw error;
  }
}

async function sendPushTopic(topic, notification) {
  webpush.setVapidDetails(WEB_PUSH_SUBJECT, WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY.value());
  const snap = await db.collection("pushSubscriptions").where("topics." + topic, "==", true).get();
  if (snap.empty) return {sent: 0, stale: 0, failed: 0};
  const payload = JSON.stringify(notification);
  let sent = 0;
  let stale = 0;
  let failed = 0;
  await mapLimit(snap.docs, 12, async (doc) => {
    const subscription = pushSubscriptionFromData(doc.data() || {});
    if (!subscription) {
      stale++;
      await doc.ref.delete().catch(() => {});
      return;
    }
    try {
      await webpush.sendNotification(subscription, payload, {TTL: 86400, urgency: "normal"});
      sent++;
    } catch (error) {
      const status = Number(error && error.statusCode || 0);
      if (status === 404 || status === 410) {
        stale++;
        await doc.ref.delete().catch(() => {});
      } else {
        failed++;
        console.error("push_delivery_failed", {topic, status});
      }
    }
  });
  return {sent, stale, failed};
}

function scoreItemsById(data) {
  const source = data && data.items || {};
  if (Array.isArray(source)) {
    return source.reduce((result, item, index) => {
      const id = cleanString(item && item.id, 100) || "row_" + index;
      result[id] = item || {};
      return result;
    }, {});
  }
  return source && typeof source === "object" ? source : {};
}

function isPublishedScore(item) {
  return Boolean(item && item.public !== false && (item.currentFilePath || item.currentFileUrl));
}

function scoreNoticeFingerprint(item) {
  if (!item) return "";
  const linkedIds = Array.isArray(item.linkedSongIds) ? item.linkedSongIds.map(String).sort() : [];
  return JSON.stringify([
    cleanString(item.title, 120), cleanString(item.scoreKind, 30), cleanString(item.instrument, 60),
    cleanString(item.currentFilePath, 1000), cleanString(item.currentFileUrl, 2000),
    cleanString(item.currentFileName, 500), cleanString(item.currentUploadedAt, 100),
    cleanString(item.currentLabel, 100), Number(item.versionNumber || 1), cleanString(item.linkedSongId, 100), linkedIds,
    cleanString(item.linkedSongName, 120), item.public !== false,
  ]);
}

function notificationTitleList(items) {
  const titles = [];
  items.forEach((item) => {
    const title = cleanString(item && item.title, 60) || "제목 없는 악보";
    if (!titles.includes(title)) titles.push(title);
  });
  if (titles.length <= 2) return titles.join(" · ");
  return titles.slice(0, 2).join(" · ") + " 외 " + (titles.length - 2) + "곡";
}

function scheduleNoticeFingerprint(data) {
  if (!data) return "";
  return JSON.stringify([
    cleanString(data.date, 20), cleanString(data.endDate, 20), cleanString(data.title, 160),
    cleanString(data.time, 30), cleanString(data.location, 160), cleanString(data.songs, 2000),
    cleanString(data.memo, 2000), Boolean(data.useBriefing), cleanString(data.program, 4000),
    cleanString(data.dress, 500), cleanString(data.briefingMemo, 2000),
  ]);
}

function scheduleMonthKeys(start, end) {
  const startMatch = cleanString(start, 20).match(/^(\d{4})-(\d{2})/);
  const endMatch = cleanString(end || start, 20).match(/^(\d{4})-(\d{2})/);
  if (!startMatch) return [];
  let year = Number(startMatch[1]);
  let month = Number(startMatch[2]);
  let endYear = endMatch ? Number(endMatch[1]) : year;
  let endMonth = endMatch ? Number(endMatch[2]) : month;
  if (endYear < year || (endYear === year && endMonth < month)) {
    endYear = year;
    endMonth = month;
  }
  const keys = [];
  for (let count = 0; count < 60 && (year < endYear || (year === endYear && month <= endMonth)); count++) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return keys;
}

function scheduleDateText(data) {
  const start = cleanString(data && data.date, 20);
  const end = cleanString(data && data.endDate, 20) || start;
  function shortDate(value) {
    const parts = value.split("-").map(Number);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return value;
    return parts[0] + "." + parts[1] + "." + parts[2];
  }
  if (!start) return "날짜 미정";
  return start === end ? shortDate(start) : shortDate(start) + "~" + shortDate(end);
}

async function notifyScoreWrite(event) {
  if (!event.data || !event.data.after.exists) return null;
  const before = event.data.before.exists ? scoreItemsById(event.data.before.data() || {}) : {};
  const after = scoreItemsById(event.data.after.data() || {});
  const changes = [];
  Object.keys(after).forEach((id) => {
    const next = after[id] || {};
    if (!isPublishedScore(next)) return;
    const previous = before[id] || null;
    if (!isPublishedScore(previous)) {
      changes.push({item: next, kind: "new"});
    } else if (scoreNoticeFingerprint(previous) !== scoreNoticeFingerprint(next)) {
      changes.push({item: next, kind: "updated"});
    }
  });
  if (!changes.length) return null;
  if (!await claimPushEvent(event.id, "scores")) return null;
  const isOnlyNew = changes.every((change) => change.kind === "new");
  const result = await sendPushTopic("scores", {
    title: isOnlyNew ? "새 악보가 등록되었습니다" : "악보가 업데이트되었습니다",
    body: notificationTitleList(changes.map((change) => change.item)),
    url: APP_URL + "?push=scores",
    tag: "choir-score-updates",
    icon: APP_URL + "assets/hymn-dove-book.png",
  });
  console.log("score_push_complete", result);
  return result;
}

async function notifyScheduleWrite(event) {
  if (!event.data) return null;
  const beforeExists = event.data.before.exists;
  const afterExists = event.data.after.exists;
  const before = beforeExists ? event.data.before.data() || {} : {};
  const after = afterExists ? event.data.after.data() || {} : {};
  if (beforeExists && afterExists && scheduleNoticeFingerprint(before) === scheduleNoticeFingerprint(after)) return null;
  if (!beforeExists && !afterExists) return null;
  if (!await claimPushEvent(event.id, "schedules")) return null;
  const item = afterExists ? after : before;
  const action = !beforeExists ? "새 일정이 등록되었습니다" : (!afterExists ? "일정이 취소되었습니다" : "일정이 변경되었습니다");
  const details = [scheduleDateText(item), cleanString(item.title, 80) || "제목 없는 일정"];
  if (afterExists && item.time) details.push(cleanString(item.time, 30));
  if (afterExists && item.location) details.push(cleanString(item.location, 60));
  const result = await sendPushTopic("schedules", {
    title: action,
    body: details.join(" · "),
    url: APP_URL + "?push=calendar",
    tag: "choir-schedule-" + cleanString(event.params.scheduleId, 100),
    icon: APP_URL + "assets/hymn-dove-book.png",
  });
  console.log("schedule_push_complete", result);
  return result;
}

async function adminBulkCreateAccounts(request) {
  requirePermission(request, "account.manage");
  const rows = Array.isArray(request.data && request.data.rows) ? request.data.rows.slice(0, 250) : [];
  if (!rows.length) throw new HttpsError("invalid-argument", "등록할 계정이 없습니다.");
  const actor = cleanString(request.auth.token.choirName, 60) || "관리자";
  const existing = await db.collection("accounts").get();
  const existingByName = new Map();
  const linkedMemberIds = new Set();
  existing.docs.forEach((doc) => {
    const data = doc.data() || {};
    const nameKey = normalizeName(data.name);
    if (!existingByName.has(nameKey)) existingByName.set(nameKey, []);
    existingByName.get(nameKey).push(doc);
    const memberId = cleanString(data.memberId, 80);
    if (memberId) linkedMemberIds.add(memberId);
  });
  const incomingPinsByName = new Map();
  const incomingMemberIds = new Set();
  const prepared = [];
  for (const row of rows) {
    const pin = cleanString(row.pin, 12);
    if (!ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "모든 PIN은 숫자 4자리여야 합니다.");
    const data = accountCreateData(row, actor);
    if (!incomingPinsByName.has(data.nameKey)) incomingPinsByName.set(data.nameKey, new Set());
    if (incomingPinsByName.get(data.nameKey).has(pin)) {
      throw new HttpsError("already-exists", data.name + " 동명이인은 서로 다른 PIN을 사용해야 합니다.");
    }
    incomingPinsByName.get(data.nameKey).add(pin);
    if (data.memberId && (linkedMemberIds.has(data.memberId) || incomingMemberIds.has(data.memberId))) {
      throw new HttpsError("already-exists", data.name + "님의 명부는 이미 다른 계정에 연결되어 있습니다.");
    }
    if (data.memberId) incomingMemberIds.add(data.memberId);
    prepared.push({ref: db.collection("accounts").doc(), data, pin});
  }
  const memberIds = Array.from(incomingMemberIds);
  if (memberIds.length) {
    const memberSnaps = await db.getAll(...memberIds.map((id) => db.collection("members").doc(id)));
    const memberById = new Map(memberSnaps.map((snap) => [snap.id, snap]));
    prepared.forEach((item) => {
      if (!item.data.memberId) return;
      const memberSnap = memberById.get(item.data.memberId);
      if (!memberSnap || !memberSnap.exists) throw new HttpsError("not-found", item.data.name + "님의 단원 명부를 찾을 수 없습니다.");
      if (normalizeName((memberSnap.data() || {}).name) !== item.data.nameKey) {
        throw new HttpsError("invalid-argument", item.data.name + " 계정과 연결할 명부의 이름이 다릅니다.");
      }
    });
  }
  await mapLimit(prepared, 3, (item) => assertPinAvailableForName(
    item.data.nameKey,
    item.pin,
    "",
    existingByName.get(item.data.nameKey) || [],
  ));
  const secrets = await mapLimit(prepared, 4, async (item) => buildAccountPinSecret(item.ref.id, item.pin));
  for (let start = 0; start < prepared.length; start += 200) {
    const batch = db.batch();
    const directorySecrets = {};
    prepared.slice(start, start + 200).forEach((item, offset) => {
      const secret = secrets[start + offset];
      batch.set(item.ref, item.data);
      batch.set(db.collection("authSecrets").doc(item.ref.id), secret);
      directorySecrets[item.ref.id] = secret;
    });
    setAccountPinDirectoryEntries(batch, directorySecrets);
    await batch.commit();
  }
  return {created: prepared.length, accounts: prepared.map((item) => safeProfile(item.ref.id, item.data))};
}

async function adminUpdateAccount(request) {
  const accountId = cleanString(request.data && request.data.accountId, 80);
  if (!isValidDocumentId(accountId)) throw new HttpsError("invalid-argument", "계정 정보가 올바르지 않습니다.");
  const ref = db.collection("accounts").doc(accountId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  const old = snap.data() || {};
  const mode = cleanString(request.data && request.data.mode, 20) || "profile";
  const update = {};
  let replacementPinSecret = null;
  if (mode === "profile") {
    requirePermission(request, "account.manage");
    update.name = cleanString(request.data.name, 60);
    update.part = cleanString(request.data.part, 30);
    update.memberId = cleanString(request.data.memberId, 80);
    if (!update.name || !update.part) throw new HttpsError("invalid-argument", "이름과 파트는 필수입니다.");
    update.nameKey = normalizeName(update.name);
    await assertMemberLinkValid(update.memberId, update.name, accountId);
    replacementPinSecret = await replacementPinForNameChange(
      normalizeName(old.name),
      update.nameKey,
      accountId,
      cleanString(request.data.pin, 12),
    );
    update.memberLinkedAt = update.memberId ? nowIso() : "";
    update.memberLinkedBy = update.memberId ? (cleanString(request.auth.token.choirName, 60) || "관리자") : "";
    if (replacementPinSecret) {
      update.pin = FieldValue.delete();
      update.pinSet = true;
      update.pinUpdatedAt = nowIso();
    }
  } else if (mode === "permissions") {
    requireAdmin(request);
    update.role = cleanString(request.data.role, 30);
    update.canArchiveUpload = Boolean(request.data.canArchiveUpload);
    update.permissionPreset = cleanString(request.data.permissionPreset, 30);
    update.permissions = uniqueAllowed(request.data.permissions, ALLOWED_PERMISSIONS);
    update.attendanceScope = normalizeAttendanceScope(request.data.attendanceScope);
    const scope = cleanString(request.data.scoreAccessScope, 20);
    update.scoreAccessScope = ALLOWED_SCORE_SCOPES.has(scope) ? scope : "default";
    update.permissionsUpdatedAt = nowIso();
    update.permissionsUpdatedBy = cleanString(request.auth.token.choirName, 60) || "관리자";
  } else {
    throw new HttpsError("invalid-argument", "지원하지 않는 수정 방식입니다.");
  }
  if (replacementPinSecret) {
    const batch = db.batch();
    batch.update(ref, update);
    batch.set(db.collection("authSecrets").doc(accountId), replacementPinSecret);
    setAccountPinDirectoryEntries(batch, {[accountId]: replacementPinSecret});
    await batch.commit();
    try { await auth.revokeRefreshTokens(accountId); } catch (error) { if (!error || error.code !== "auth/user-not-found") throw error; }
  } else {
    await ref.update(update);
  }
  const next = Object.assign({}, old, update);
  await syncExistingAccountClaims(accountId, next);
  return {account: safeProfile(accountId, next)};
}

async function setOwnScorePartPreferences(request) {
  requireAuth(request);
  if (request.auth.token.account !== true) {
    throw new HttpsError("permission-denied", "단원 계정으로 로그인해주세요.");
  }
  const preferences = normalizeScorePartPreferences(request.data && request.data.scorePartPreferences);
  const ref = db.collection("accounts").doc(request.auth.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  const old = snap.data() || {};
  const update = {
    scorePartPreferences: preferences,
    scorePartPreferencesUpdatedAt: nowIso(),
  };
  await ref.update(update);
  const next = Object.assign({}, old, update);
  return {account: safeProfile(request.auth.uid, next)};
}

async function adminBulkLinkAccounts(request) {
  requirePermission(request, "account.manage");
  const rows = Array.isArray(request.data && request.data.rows) ? request.data.rows.slice(0, 300) : [];
  const actor = cleanString(request.auth.token.choirName, 60) || "관리자";
  const changed = [];
  const accountIds = new Set();
  const memberIds = new Set();
  for (const row of rows) {
    const accountId = cleanString(row.accountId, 80);
    const memberId = cleanString(row.memberId, 80);
    if (!accountId || !memberId) continue;
    if (!isValidDocumentId(accountId) || !isValidDocumentId(memberId)) {
      throw new HttpsError("invalid-argument", "계정 또는 단원 명부 정보가 올바르지 않습니다.");
    }
    if (accountIds.has(accountId) || memberIds.has(memberId)) {
      throw new HttpsError("already-exists", "같은 계정이나 명부가 연결 목록에 중복되어 있습니다.");
    }
    accountIds.add(accountId);
    memberIds.add(memberId);
    changed.push({accountId, memberId});
  }
  if (!changed.length) return {updated: 0};
  const [accountSnaps, memberSnaps, allAccounts] = await Promise.all([
    db.getAll(...changed.map((row) => db.collection("accounts").doc(row.accountId))),
    db.getAll(...changed.map((row) => db.collection("members").doc(row.memberId))),
    db.collection("accounts").get(),
  ]);
  const accountById = new Map(accountSnaps.map((snap) => [snap.id, snap]));
  const memberById = new Map(memberSnaps.map((snap) => [snap.id, snap]));
  const linkedByMember = new Map();
  allAccounts.docs.forEach((doc) => {
    const memberId = cleanString((doc.data() || {}).memberId, 80);
    if (memberId) linkedByMember.set(memberId, doc.id);
  });
  changed.forEach((row) => {
    const accountSnap = accountById.get(row.accountId);
    const memberSnap = memberById.get(row.memberId);
    if (!accountSnap || !accountSnap.exists) throw new HttpsError("not-found", "연결할 계정을 찾을 수 없습니다.");
    if (!memberSnap || !memberSnap.exists) throw new HttpsError("not-found", "연결할 단원 명부를 찾을 수 없습니다.");
    if (normalizeName((accountSnap.data() || {}).name) !== normalizeName((memberSnap.data() || {}).name)) {
      throw new HttpsError("invalid-argument", "계정 이름과 명부 이름이 같아야 연결할 수 있습니다.");
    }
    const linkedAccountId = linkedByMember.get(row.memberId);
    if (linkedAccountId && linkedAccountId !== row.accountId) {
      throw new HttpsError("already-exists", "해당 단원 명부는 이미 다른 계정에 연결되어 있습니다.");
    }
  });
  const batch = db.batch();
  changed.forEach((row) => {
    batch.update(db.collection("accounts").doc(row.accountId), {memberId: row.memberId, memberLinkedAt: nowIso(), memberLinkedBy: actor});
  });
  await batch.commit();
  await mapLimit(changed, 5, async (row) => {
    const snap = await db.collection("accounts").doc(row.accountId).get();
    if (snap.exists) await syncExistingAccountClaims(row.accountId, snap.data() || {});
  });
  return {updated: changed.length};
}

async function adminSetAccountPin(request) {
  requirePermission(request, "account.pin");
  const accountId = cleanString(request.data && request.data.accountId, 80);
  const pin = cleanString(request.data && request.data.pin, 12);
  if (!isValidDocumentId(accountId) || !ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리여야 합니다.");
  const accountRef = db.collection("accounts").doc(accountId);
  const accountSnap = await accountRef.get();
  if (!accountSnap.exists) throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  const account = accountSnap.data() || {};
  await assertPinAvailableForName(normalizeName(account.name), pin, accountId);
  const secret = await buildAccountPinSecret(accountId, pin);
  const batch = db.batch();
  batch.set(db.collection("authSecrets").doc(accountId), secret);
  setAccountPinDirectoryEntries(batch, {[accountId]: secret});
  batch.update(accountRef, {pin: FieldValue.delete(), pinSet: true, pinUpdatedAt: nowIso()});
  await batch.commit();
  try { await auth.revokeRefreshTokens(accountId); } catch (error) { if (!error || error.code !== "auth/user-not-found") throw error; }
  return {ok: true};
}

async function adminDeleteAccount(request) {
  requireAdmin(request);
  const accountId = cleanString(request.data && request.data.accountId, 80);
  if (!isValidDocumentId(accountId)) throw new HttpsError("invalid-argument", "계정 정보가 올바르지 않습니다.");
  const batch = db.batch();
  batch.delete(db.collection("accounts").doc(accountId));
  batch.delete(db.collection("authSecrets").doc(accountId));
  deleteAccountPinDirectoryEntry(batch, accountId);
  await batch.commit();
  try { await auth.deleteUser(accountId); } catch (error) { if (!error || error.code !== "auth/user-not-found") throw error; }
  return {ok: true};
}

async function adminRevealAccountPins(request) {
  requireAdmin(request);
  const rawIds = Array.isArray(request.data && request.data.accountIds) ? request.data.accountIds.slice(0, 250) : [];
  const accountIds = [];
  rawIds.forEach((value) => {
    const id = cleanString(value, 80);
    if (!isValidDocumentId(id)) throw new HttpsError("invalid-argument", "계정 정보가 올바르지 않습니다.");
    if (!accountIds.includes(id)) accountIds.push(id);
  });
  if (!accountIds.length) return {pins: {}, unavailable: []};
  const directorySnap = await accountPinDirectoryRef().get();
  const directoryData = directorySnap.exists ? directorySnap.data() || {} : {};
  const directoryPins = directoryData.pins && typeof directoryData.pins === "object" ? directoryData.pins : {};
  const pins = {};
  const unavailable = [];
  const fallbackIds = [];
  accountIds.forEach((accountId) => {
    const entry = directoryPins[accountId];
    if (entry && entry.unavailable === true) {
      unavailable.push(accountId);
      return;
    }
    const pin = decryptAccountPin(accountId, entry || {});
    if (pin) pins[accountId] = pin;
    else fallbackIds.push(accountId);
  });
  const repairedEntries = {};
  if (fallbackIds.length) {
    const snaps = await db.getAll(...fallbackIds.map((id) => db.collection("authSecrets").doc(id)));
    snaps.forEach((snap, index) => {
      const accountId = fallbackIds[index];
      const secret = snap.exists ? snap.data() || {} : {};
      const pin = decryptAccountPin(accountId, secret);
      if (pin) {
        pins[accountId] = pin;
        repairedEntries[accountId] = secret;
      } else {
        unavailable.push(accountId);
      }
    });
    const directoryPatch = {};
    Object.keys(repairedEntries).forEach((accountId) => {
      directoryPatch[accountId] = accountPinDirectoryEntry(repairedEntries[accountId]);
    });
    fallbackIds.forEach((accountId) => {
      if (!directoryPatch[accountId]) directoryPatch[accountId] = {unavailable: true, checkedAt: nowIso()};
    });
    await accountPinDirectoryRef().set({
      kind: "account-pin-directory",
      pins: directoryPatch,
      updatedAt: nowIso(),
    }, {merge: true});
  }
  return {
    pins,
    unavailable,
    diagnostics: {directoryReads: 1, fallbackReads: fallbackIds.length, repaired: Object.keys(repairedEntries).length},
  };
}

async function bootstrapSecurity(request) {
  requireAdmin(request);
  const accountSnap = await db.collection("accounts").get();
  let migrated = 0;
  let missingPin = 0;
  const prepared = await mapLimit(accountSnap.docs, 4, async (doc) => {
    const data = doc.data() || {};
    const pin = cleanString(data.pin, 20);
    const secretSnap = await db.collection("authSecrets").doc(doc.id).get();
    if (!pin && !secretSnap.exists) {
      missingPin++;
      return {doc, data, secret: null, hasSecret: false};
    }
    const secret = pin ? await buildAccountPinSecret(doc.id, pin) : null;
    if (pin) migrated++;
    return {doc, data, secret, directorySecret: secret || (secretSnap.exists ? secretSnap.data() || {} : null), hasSecret: secretSnap.exists || Boolean(secret)};
  });
  for (let start = 0; start < prepared.length; start += 200) {
    const batch = db.batch();
    const directorySecrets = {};
    prepared.slice(start, start + 200).forEach((item) => {
      const update = {nameKey: normalizeName(item.data.name), pin: FieldValue.delete(), pinSet: Boolean(item.hasSecret || item.data.pinSet), securityMigratedAt: nowIso()};
      batch.update(item.doc.ref, update);
      if (item.secret) batch.set(db.collection("authSecrets").doc(item.doc.id), item.secret);
      if (item.directorySecret) directorySecrets[item.doc.id] = item.directorySecret;
    });
    setAccountPinDirectoryEntries(batch, directorySecrets);
    await batch.commit();
  }
  const adminSettings = await db.collection("settings").doc("admin").get();
  const adminData = adminSettings.exists ? adminSettings.data() || {} : {};
  const legacyBatch = db.batch();
  let legacyChanged = false;
  if (adminData.adminPasswordHash && adminData.adminPasswordSalt) {
    legacyBatch.set(db.collection("authSecrets").doc("legacy-admin"), {kind: "legacy", role: "admin", hashVersion: "legacy-sha256", hash: String(adminData.adminPasswordHash), salt: String(adminData.adminPasswordSalt), updatedAt: nowIso()});
    legacyBatch.update(adminSettings.ref, {adminPasswordHash: FieldValue.delete(), adminPasswordSalt: FieldValue.delete(), securityMigratedAt: nowIso()});
    legacyChanged = true;
  }
  if (adminData.chongmuPassword) {
    const chongmuSecret = await hashPassword(String(adminData.chongmuPassword));
    legacyBatch.set(db.collection("authSecrets").doc("legacy-chongmu"), Object.assign({kind: "legacy", role: "chongmu"}, chongmuSecret));
    legacyBatch.update(adminSettings.ref, {chongmuPassword: FieldValue.delete(), securityMigratedAt: nowIso()});
    legacyChanged = true;
  }
  if (legacyChanged) await legacyBatch.commit();
  return {accounts: accountSnap.size, migrated, missingPin};
}

async function secureScoreFiles(request) {
  requireAdmin(request);
  const bucket = getStorage().bucket();
  await bucket.setCorsConfiguration([{
    origin: ["https://twd412412-ux.github.io", "http://127.0.0.1:8765", "http://localhost:8765"],
    method: ["GET", "HEAD"],
    responseHeader: ["Content-Type", "Content-Length", "Content-Disposition"],
    maxAgeSeconds: 3600,
  }]);
  const [files] = await bucket.getFiles({prefix: "scores/"});
  await mapLimit(files, 8, async (file) => {
    await file.setMetadata({metadata: {firebaseStorageDownloadTokens: crypto.randomUUID()}});
  });
  const scoreRef = db.collection("settings").doc("scores");
  const scoreSnap = await scoreRef.get();
  let protectedRows = 0;
  if (scoreSnap.exists) {
    const data = scoreSnap.data() || {};
    const protectItem = (item) => {
      const next = Object.assign({}, item);
      if (next.currentFilePath) {
        next.currentFileUrl = "";
        protectedRows++;
      }
      return next;
    };
    const sourceItems = data.items || {};
    const items = Array.isArray(sourceItems)
      ? sourceItems.map(protectItem)
      : Object.keys(sourceItems).reduce((result, id) => {
        result[id] = protectItem(sourceItems[id]);
        return result;
      }, {});
    await scoreRef.set({items, securityUpdatedAt: nowIso()}, {merge: true});
  }
  return {files: files.length, protectedRows};
}

function normalizeScoreKind(value) {
  const kind = cleanString(value, 30).toLowerCase();
  return ["orchestra", "orch", "instrument", "part"].includes(kind) ? "orchestra" : "singer";
}

function normalizeScoreLinkedSongIds(values) {
  const rows = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const id = cleanString(value, 100);
    if (id && isValidDocumentId(id) && !rows.includes(id) && rows.length < 80) rows.push(id);
  });
  return rows;
}

function scoreActor(request) {
  const token = request.auth && request.auth.token ? request.auth.token : {};
  let id = request.auth ? request.auth.uid : "";
  if (token.account !== true && token.legacyRole === "chongmu") id = "chongmu";
  else if (token.account !== true && token.admin === true) id = "admin";
  return {
    id,
    name: cleanString(token.choirName, 60) || (token.admin === true ? "관리자" : "권한자"),
  };
}

function validScoreFilePath(scoreId, path) {
  const value = cleanString(path, 1500);
  return !value || (
    value.startsWith(`scores/${scoreId}/`) &&
    !value.includes("..") &&
    !value.includes("\\")
  );
}

function sanitizeScoreItem(raw, scoreId, existing, actor) {
  raw = raw && typeof raw === "object" ? raw : {};
  existing = existing && typeof existing === "object" ? existing : null;
  const title = cleanString(raw.title || raw.songName, 160);
  if (!title) throw new HttpsError("invalid-argument", "곡명을 입력해주세요.");
  const scoreKind = normalizeScoreKind(raw.scoreKind || raw.kind);
  const instrument = scoreKind === "orchestra"
    ? cleanString(raw.instrument || raw.instrumentLabel, 80).replace(/\s+/g, " ")
    : "";
  const instrumentLabel = scoreKind === "orchestra"
    ? cleanString(raw.instrumentLabel || instrument, 80).replace(/\s+/g, " ")
    : "";
  const currentFilePath = cleanString(raw.currentFilePath || raw.filePath, 1500);
  const currentFileUrl = currentFilePath ? "" : cleanString(raw.currentFileUrl || raw.fileUrl, 2000);
  if (!validScoreFilePath(scoreId, currentFilePath)) {
    throw new HttpsError("invalid-argument", "악보 파일 경로가 올바르지 않습니다.");
  }
  if (currentFileUrl && !/^https?:\/\//i.test(currentFileUrl)) {
    throw new HttpsError("invalid-argument", "외부 PDF 주소를 확인해주세요.");
  }
  if (!currentFilePath && !currentFileUrl) {
    throw new HttpsError("invalid-argument", "PDF 파일 또는 외부 PDF 주소가 필요합니다.");
  }
  const linkedSongIds = normalizeScoreLinkedSongIds(raw.linkedSongIds);
  const linkedSongId = cleanString(raw.linkedSongId, 100);
  if (linkedSongId && isValidDocumentId(linkedSongId) && !linkedSongIds.includes(linkedSongId)) {
    linkedSongIds.unshift(linkedSongId);
  }
  const fileChanged = Boolean(existing) && (
    cleanString(existing.currentFilePath || existing.filePath, 1500) !== currentFilePath ||
    cleanString(existing.currentFileUrl || existing.fileUrl, 2000) !== currentFileUrl ||
    cleanString(existing.currentFileName || existing.fileName, 500) !== cleanString(raw.currentFileName || raw.fileName, 500)
  );
  const previousVersion = Math.max(1, Number(existing && existing.versionNumber || 1));
  const versionNumber = existing ? (fileChanged ? previousVersion + 1 : previousVersion) : 1;
  const now = nowIso();
  const next = {
    id: scoreId,
    title,
    searchKey: cleanString(raw.searchKey, 300),
    scoreKind,
    instrument,
    instrumentLabel,
    public: raw.public !== false,
    currentFileUrl,
    currentFilePath,
    currentFileName: safeScoreFileName(raw.currentFileName || raw.fileName, {title}),
    currentFileSize: (() => {
      const size = Number(raw.currentFileSize || raw.fileSize || 0);
      return Number.isFinite(size) ? Math.max(0, Math.min(size, 30 * 1024 * 1024)) : 0;
    })(),
    currentUploadedAt: fileChanged || !existing
      ? cleanString(raw.currentUploadedAt, 100) || now
      : cleanString(existing.currentUploadedAt || existing.fileUploadedAt, 100),
    currentLabel: cleanString(raw.currentLabel || raw.versionLabel, 100),
    versionNumber,
    previousFileName: fileChanged
      ? cleanString(existing.currentFileName || existing.fileName, 500)
      : cleanString(existing && existing.previousFileName, 500),
    linkedSongId: linkedSongIds[0] || "",
    linkedSongIds,
    linkedSongName: cleanString(raw.linkedSongName, 160),
    createdAt: cleanString(existing && existing.createdAt, 100) || now,
    createdById: cleanString(existing && existing.createdById, 100) || actor.id,
    createdByName: cleanString(existing && existing.createdByName, 60) || actor.name,
    updatedAt: now,
    updatedById: actor.id,
    updatedByName: actor.name,
  };
  return {next, fileChanged};
}

function canEditStoredScore(request, score) {
  if (isAdminRequest(request) || hasPermission(request, "score.editAny")) return true;
  if (!hasPermission(request, "score.manage")) return false;
  const actor = scoreActor(request);
  const ownerId = cleanString(score && score.createdById, 100);
  const ownerName = cleanString(score && score.createdByName, 60);
  return ownerId === actor.id || (!ownerId && ownerName && ownerName === actor.name);
}

async function deleteScoreObject(path) {
  const value = cleanString(path, 1500);
  if (!value || !value.startsWith("scores/") || value.includes("..")) return false;
  try {
    await getStorage().bucket().file(value).delete({ignoreNotFound: true});
    return true;
  } catch (error) {
    console.error("score_file_cleanup_failed", {path: value, code: error && error.code});
    return false;
  }
}

async function cleanupReplacedScoreFiles(rows) {
  const paths = new Set();
  rows.forEach((row) => {
    if (row && row.path) paths.add(row.path);
    if (row && row.canonicalPath && row.canonicalPath !== row.path) paths.add(row.canonicalPath);
  });
  await mapLimit(Array.from(paths), 6, deleteScoreObject);
}

async function upsertScores(request) {
  requirePermission(request, "score.manage");
  const requested = Array.isArray(request.data && request.data.items)
    ? request.data.items.slice(0, 30)
    : [];
  if (!requested.length) throw new HttpsError("invalid-argument", "저장할 악보가 없습니다.");
  const ids = new Set();
  requested.forEach((raw) => {
    const id = cleanString(raw && raw.id, 180);
    if (!isValidDocumentId(id) || ids.has(id)) {
      throw new HttpsError("invalid-argument", "악보 식별값을 확인해주세요.");
    }
    ids.add(id);
  });
  const scoreRef = db.collection("settings").doc("scores");
  const actor = scoreActor(request);
  const cleanupRows = [];
  let savedItems = [];
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(scoreRef);
    const data = snap.exists ? snap.data() || {} : {};
    const items = Object.assign({}, scoreItemsById(data));
    savedItems = requested.map((raw) => {
      const id = cleanString(raw.id, 180);
      const existing = items[id] || null;
      if (existing && !canEditStoredScore(request, existing)) {
        throw new HttpsError("permission-denied", "다른 사람이 등록한 악보를 수정할 권한이 없습니다.");
      }
      const sanitized = sanitizeScoreItem(raw, id, existing, actor);
      if (existing && sanitized.fileChanged) {
        const oldPath = cleanString(existing.currentFilePath || existing.filePath, 1500);
        const oldName = safeScoreFileName(existing.currentFileName || existing.fileName, existing);
        cleanupRows.push({
          path: oldPath,
          canonicalPath: oldPath ? `scores/${id}/${oldName}` : "",
        });
      }
      items[id] = sanitized.next;
      return sanitized.next;
    });
    const estimatedBytes = Buffer.byteLength(JSON.stringify(items), "utf8");
    if (estimatedBytes > 850000) {
      throw new HttpsError("resource-exhausted", "악보 목록 용량이 안전 한도에 가까워 저장할 수 없습니다.");
    }
    tx.set(scoreRef, {
      items,
      updatedAt: nowIso(),
      updatedById: actor.id,
      updatedByName: actor.name,
    }, {merge: true});
  });
  await cleanupReplacedScoreFiles(cleanupRows);
  return {items: savedItems};
}

async function deleteStoredScore(request) {
  requireAdmin(request);
  const scoreId = cleanString(request.data && request.data.scoreId, 180);
  if (!isValidDocumentId(scoreId)) throw new HttpsError("invalid-argument", "삭제할 악보를 확인해주세요.");
  const scoreRef = db.collection("settings").doc("scores");
  let deleted = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(scoreRef);
    if (!snap.exists) throw new HttpsError("not-found", "악보를 찾을 수 없습니다.");
    const data = snap.data() || {};
    const items = Object.assign({}, scoreItemsById(data));
    deleted = items[scoreId] || null;
    if (!deleted) throw new HttpsError("not-found", "악보를 찾을 수 없습니다.");
    delete items[scoreId];
    const actor = scoreActor(request);
    tx.set(scoreRef, {
      items,
      updatedAt: nowIso(),
      updatedById: actor.id,
      updatedByName: actor.name,
    }, {merge: true});
  });
  await getStorage().bucket().deleteFiles({prefix: `scores/${scoreId}/`}).catch((error) => {
    console.error("score_folder_cleanup_failed", {scoreId, code: error && error.code});
  });
  return {deleted: scoreId};
}

async function cleanupUnusedScoreUploads(request) {
  requirePermission(request, "score.manage");
  const requested = Array.isArray(request.data && request.data.paths) ? request.data.paths.slice(0, 40) : [];
  const paths = requested.map((value) => cleanString(value, 1500)).filter((value) => (
    value.startsWith("scores/") && value.includes("/uploads/") && !value.includes("..")
  ));
  if (!paths.length) return {deleted: 0};
  const snap = await db.collection("settings").doc("scores").get();
  const inUse = new Set(Object.values(scoreItemsById(snap.exists ? snap.data() || {} : {}))
    .map((item) => cleanString(item && item.currentFilePath, 1500))
    .filter(Boolean));
  const unused = paths.filter((path) => !inUse.has(path));
  const results = await mapLimit(unused, 6, deleteScoreObject);
  return {deleted: results.filter(Boolean).length};
}

function scoreAccessModes(request) {
  if (isAdminRequest(request) || hasPermission(request, "score.manage")) return ["singer", "orchestra"];
  const token = request.auth && request.auth.token ? request.auth.token : {};
  const scope = ALLOWED_SCORE_SCOPES.has(token.scoreAccessScope) ? token.scoreAccessScope : "default";
  if (scope === "all") return ["singer", "orchestra"];
  if (scope === "singer" || scope === "orchestra") return [scope];
  if (scope === "none") return [];
  const part = cleanString(token.choirPart, 30);
  if (part === "지휘") return ["singer", "orchestra"];
  if (part === "관현악") return ["orchestra"];
  return token.account === true ? ["singer"] : [];
}

function safeScoreFileName(value, score) {
  let name = cleanString(value, 240).replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  if (!name) name = cleanString(score && (score.title || score.songName), 160) || "score";
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  return name;
}

function scoreContentDisposition(value) {
  const fileName = safeScoreFileName(value);
  let fallback = fileName.normalize ? fileName.normalize("NFKD") : fileName;
  fallback = fallback.replace(/[^\x20-\x7e]/g, "_").replace(/[;"\\]/g, "_");
  if (!/[A-Za-z0-9]/.test(fallback)) fallback = "score.pdf";
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function canonicalScoreFile(bucket, scoreId, sourcePath, fileName) {
  const canonicalPath = `scores/${scoreId}/${fileName}`;
  if (sourcePath === canonicalPath) return bucket.file(sourcePath);

  const sourceFile = bucket.file(sourcePath);
  const canonicalFile = bucket.file(canonicalPath);
  let canonicalSource = "";
  try {
    const [metadata] = await canonicalFile.getMetadata();
    canonicalSource = cleanString(metadata && metadata.metadata && metadata.metadata.choirSourcePath, 1500);
  } catch (error) {
    if (Number(error && error.code) !== 404) throw error;
  }
  if (canonicalSource !== sourcePath) {
    await sourceFile.copy(canonicalFile, {
      contentType: "application/pdf",
      contentDisposition: scoreContentDisposition(fileName),
      metadata: {choirSourcePath: sourcePath},
    });
  }
  return canonicalFile;
}

async function verifySignedScoreUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {Range: "bytes=0-0"},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("score_signed_url_http_" + response.status);
    if (response.body) await response.body.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

async function openScoreFile(request) {
  requireAuth(request);
  const scoreId = cleanString(request.data && request.data.scoreId, 180);
  if (!isValidDocumentId(scoreId)) throw new HttpsError("invalid-argument", "악보를 확인해주세요.");

  const scoreSnap = await db.collection("settings").doc("scores").get();
  const sourceItems = scoreSnap.exists ? (scoreSnap.data() || {}).items || {} : {};
  const score = Array.isArray(sourceItems)
    ? sourceItems.find((item) => item && cleanString(item.id, 180) === scoreId)
    : sourceItems[scoreId];
  if (!score) throw new HttpsError("not-found", "악보를 찾을 수 없습니다.");

  const canManage = isAdminRequest(request) || hasPermission(request, "score.manage");
  const kind = normalizeScoreKind(score.scoreKind || score.kind);
  if (!canManage && (score.public === false || !scoreAccessModes(request).includes(kind))) {
    throw new HttpsError("permission-denied", "이 악보를 볼 권한이 없습니다.");
  }

  const filePath = cleanString(score.currentFilePath || score.filePath, 1500);
  if (!filePath || !filePath.startsWith("scores/") || filePath.includes("..")) {
    throw new HttpsError("not-found", "저장된 악보 파일을 찾을 수 없습니다.");
  }
  const fileName = safeScoreFileName(score.currentFileName || score.fileName, score);
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const bucket = getStorage().bucket();
  const file = bucket.file(filePath);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: expiresAt,
    responseDisposition: scoreContentDisposition(fileName),
    responseType: "application/pdf",
  });
  return {url, fileName, expiresAt};
}

function songIndexShardId(songId) {
  const digest = crypto.createHash("sha256").update(String(songId)).digest();
  return "shard_" + String(digest.readUInt16BE(0) % SONG_INDEX_SHARDS).padStart(2, "0");
}

async function rebuildSongIndex(request) {
  requireAdmin(request);
  const songsSnap = await db.collection("songs").get();
  const shards = {};
  for (let i = 0; i < SONG_INDEX_SHARDS; i++) shards["shard_" + String(i).padStart(2, "0")] = {};
  songsSnap.docs.forEach((doc) => {
    shards[songIndexShardId(doc.id)][doc.id] = doc.data() || {};
  });
  const shardBytes = Object.keys(shards).map((id) => ({id, bytes: Buffer.byteLength(JSON.stringify(shards[id]), "utf8")}));
  const oversized = shardBytes.find((row) => row.bytes > 850000);
  if (oversized) throw new HttpsError("resource-exhausted", "곡 색인 묶음 크기가 안전 한도를 넘었습니다.");
  const batch = db.batch();
  Object.keys(shards).forEach((id) => {
    batch.set(db.collection("songIndex").doc(id), {items: shards[id], updatedAt: nowIso()});
  });
  batch.set(db.collection("songIndex").doc("_meta"), {
    count: songsSnap.size,
    shardCount: SONG_INDEX_SHARDS,
    version: 1,
    updatedAt: nowIso(),
  });
  await batch.commit();
  return {
    songs: songsSnap.size,
    shards: SONG_INDEX_SHARDS,
    maxShardBytes: Math.max(...shardBytes.map((row) => row.bytes), 0),
  };
}

function archiveReactionType(data) {
  const type = cleanString(data && data.type, 30);
  return ARCHIVE_REACTION_TYPES.has(type) ? type : "";
}

async function syncArchiveReaction(event) {
  const before = event.data && event.data.before.exists ? event.data.before.data() || {} : {};
  const after = event.data && event.data.after.exists ? event.data.after.data() || {} : {};
  const archiveId = cleanString(after.archiveId || before.archiveId, 180);
  if (!isValidDocumentId(archiveId)) return null;
  const beforeType = archiveReactionType(before);
  const afterType = archiveReactionType(after);
  if (beforeType === afterType) return null;
  const ref = db.collection("mediaArchive").doc(archiveId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() || {};
    const reactions = Object.assign({}, data.reactions || {});
    if (beforeType) reactions[beforeType] = Math.max(0, Number(reactions[beforeType] || 0) - 1);
    if (afterType) reactions[afterType] = Math.max(0, Number(reactions[afterType] || 0) + 1);
    Object.keys(reactions).forEach((key) => {
      if (!ARCHIVE_REACTION_TYPES.has(key) || Number(reactions[key] || 0) <= 0) delete reactions[key];
    });
    tx.update(ref, {reactions, reactionUpdatedAt: nowIso()});
  });
  return null;
}

async function cleanupDeletedArchive(event) {
  if (!event.data || event.data.after.exists || !event.data.before.exists) return null;
  const archiveId = event.params.archiveId;
  const before = event.data.before.data() || {};
  await db.collection("mediaArchivePrivate").doc(archiveId).delete().catch(() => {});
  while (true) {
    const snap = await db.collection("archiveReactions").where("archiveId", "==", archiveId).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < 400) break;
  }
  const path = cleanString(before.path, 1500);
  if (path && path.startsWith("archive/") && !path.includes("..")) {
    await getStorage().bucket().file(path).delete({ignoreNotFound: true}).catch((error) => {
      console.error("archive_file_cleanup_failed", {archiveId, code: error && error.code});
    });
  }
  return null;
}

async function ensureScheduleMonthIndex(event) {
  if (!event.data || !event.data.after.exists) return null;
  const data = event.data.after.data() || {};
  const expected = scheduleMonthKeys(data.date, data.endDate || data.date);
  const current = Array.isArray(data.monthKeys) ? data.monthKeys : [];
  if (JSON.stringify(current) === JSON.stringify(expected)) return null;
  await event.data.after.ref.update({monthKeys: expected});
  return null;
}

exports.authGateway = onCall({secrets: [ACCOUNT_PIN_ENCRYPTION_KEY]}, async (request) => {
  const action = cleanString(request.data && request.data.action, 40);
  if (action === "loginWithPin") return loginWithPin(request);
  if (action === "loginLegacyRole") return loginLegacyRole(request);
  if (action === "endElevatedSession") return endElevatedSession(request);
  if (action === "resetLegacyPassword") return resetLegacyPassword(request);
  throw new HttpsError("invalid-argument", "지원하지 않는 인증 요청입니다.");
});

exports.accountAdmin = onCall({timeoutSeconds: 120, memory: "512MiB", secrets: [ACCOUNT_PIN_ENCRYPTION_KEY]}, async (request) => {
  const action = cleanString(request.data && request.data.action, 40);
  if (action === "create") return adminCreateAccount(request);
  if (action === "bulkCreate") return adminBulkCreateAccounts(request);
  if (action === "update") return adminUpdateAccount(request);
  if (action === "bulkLink") return adminBulkLinkAccounts(request);
  if (action === "setPin") return adminSetAccountPin(request);
  if (action === "revealPins") return adminRevealAccountPins(request);
  if (action === "delete") return adminDeleteAccount(request);
  if (action === "setOwnScoreParts") return setOwnScorePartPreferences(request);
  throw new HttpsError("invalid-argument", "지원하지 않는 계정 관리 요청입니다.");
});

exports.scoreAdmin = onCall({timeoutSeconds: 120, memory: "512MiB"}, async (request) => {
  const action = cleanString(request.data && request.data.action, 40);
  if (action === "upsert") return upsertScores(request);
  if (action === "delete") return deleteStoredScore(request);
  if (action === "cleanupUploads") return cleanupUnusedScoreUploads(request);
  throw new HttpsError("invalid-argument", "지원하지 않는 악보 관리 요청입니다.");
});

exports.scoreFileAccess = onCall(async (request) => {
  try {
    return await openScoreFile(request);
  } catch (error) {
    if (!(error instanceof HttpsError)) {
      console.error("score_file_access_failed", {
        scoreId: cleanString(request.data && request.data.scoreId, 180),
        code: error && error.code,
        message: error && error.message,
      });
    }
    throw error;
  }
});

exports.securityMaintenance = onCall({timeoutSeconds: 300, memory: "512MiB", secrets: [ACCOUNT_PIN_ENCRYPTION_KEY]}, async (request) => {
  const action = cleanString(request.data && request.data.action, 40);
  if (action === "bootstrap") return bootstrapSecurity(request);
  if (action === "secureScores") return secureScoreFiles(request);
  if (action === "rebuildSongIndex") return rebuildSongIndex(request);
  throw new HttpsError("invalid-argument", "지원하지 않는 보안 정리 요청입니다.");
});

exports.syncSongIndex = onDocumentWritten("songs/{songId}", async (event) => {
  const songId = event.params.songId;
  const beforeExists = event.data.before.exists;
  const afterExists = event.data.after.exists;
  const shardRef = db.collection("songIndex").doc(songIndexShardId(songId));
  const metaRef = db.collection("songIndex").doc("_meta");
  await db.runTransaction(async (tx) => {
    const [shardSnap, metaSnap] = await Promise.all([tx.get(shardRef), tx.get(metaRef)]);
    const shardData = shardSnap.exists ? shardSnap.data() || {} : {};
    const items = Object.assign({}, shardData.items || {});
    if (afterExists) items[songId] = event.data.after.data() || {};
    else delete items[songId];
    const estimatedBytes = Buffer.byteLength(JSON.stringify(items), "utf8");
    if (estimatedBytes > 850000) throw new Error("song_index_shard_too_large");
    const oldCount = Number(metaSnap.exists ? (metaSnap.data() || {}).count : 0);
    const delta = !beforeExists && afterExists ? 1 : (beforeExists && !afterExists ? -1 : 0);
    tx.set(shardRef, {items, updatedAt: nowIso()});
    tx.set(metaRef, {
      count: Math.max(0, oldCount + delta),
      shardCount: SONG_INDEX_SHARDS,
      version: 1,
      updatedAt: nowIso(),
    });
  });
});

exports.notifyScoreUpdates = onDocumentWritten({
  document: "settings/scores",
  secrets: [WEB_PUSH_PRIVATE_KEY],
  retry: false,
}, notifyScoreWrite);

exports.notifyScheduleUpdates = onDocumentWritten({
  document: "schedules/{scheduleId}",
  secrets: [WEB_PUSH_PRIVATE_KEY],
  retry: false,
}, notifyScheduleWrite);

exports.syncArchiveReactionCounts = onDocumentWritten({
  document: "archiveReactions/{reactionId}",
  retry: false,
}, syncArchiveReaction);

exports.cleanupDeletedArchive = onDocumentWritten({
  document: "mediaArchive/{archiveId}",
  retry: false,
}, cleanupDeletedArchive);

exports.ensureScheduleMonthIndex = onDocumentWritten({
  document: "schedules/{scheduleId}",
  retry: false,
}, ensureScheduleMonthIndex);
