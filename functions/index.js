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
const WEB_PUSH_PUBLIC_KEY = "BP86C82vcDoE_quMY8q6mUDNmrfMyHQMXfTeM7DPuxqRlq-newKbPf_bRb84fZEHdUiGQjMaE72ByhAV34Qw5qY";
const WEB_PUSH_PRIVATE_KEY = defineSecret("WEB_PUSH_PRIVATE_KEY");
const WEB_PUSH_SUBJECT = "mailto:twd412412@gmail.com";
const APP_URL = "https://twd412412-ux.github.io/260410choir_program/";
const ALLOWED_SCORE_SCOPES = new Set(["default", "all", "singer", "orchestra", "none"]);
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
    memberId: cleanString(account.memberId, 80),
    role: cleanString(account.role, 30),
    canArchiveUpload: Boolean(account.canArchiveUpload),
    permissionPreset: cleanString(account.permissionPreset, 30),
    permissions: accountPermissions(account),
    attendanceScope: normalizeAttendanceScope(account.attendanceScope),
    scoreAccessScope: ALLOWED_SCORE_SCOPES.has(account.scoreAccessScope) ? account.scoreAccessScope : "default",
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
  let snap = await db.collection("accounts").where("nameKey", "==", nameKey).limit(3).get();
  if (snap.empty) snap = await db.collection("accounts").where("name", "==", cleanString(name, 60)).limit(3).get();
  return {nameKey, rows: snap.docs};
}

async function accountSecret(accountDoc) {
  const ref = db.collection("authSecrets").doc(accountDoc.id);
  const secretSnap = await ref.get();
  if (secretSnap.exists) return {ref, secret: secretSnap.data(), legacyPin: ""};
  const account = accountDoc.data() || {};
  return {ref, secret: null, legacyPin: cleanString(account.pin, 20)};
}

async function loginWithPin(request) {
  const name = cleanString(request.data && request.data.name, 60);
  const pin = cleanString(request.data && request.data.pin, 12);
  if (!name || !ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "이름과 PIN 4자리를 확인해주세요.");
  const found = await accountForName(name);
  const rateKeys = [rateKey("account", found.nameKey), rateKey("ip", requestIp(request))];
  await assertRateAllowed(rateKeys);
  if (found.rows.length !== 1) {
    await recordRateFailure(rateKeys, 8, 10 * 60 * 1000);
    throw new HttpsError("invalid-argument", found.rows.length > 1 ? "동명이인 계정은 관리자에게 문의해주세요." : "이름 또는 PIN을 확인해주세요.");
  }
  const accountDoc = found.rows[0];
  const account = accountDoc.data() || {};
  const secretInfo = await accountSecret(accountDoc);
  let valid = false;
  if (secretInfo.secret) valid = await verifyPassword(pin, secretInfo.secret);
  else if (secretInfo.legacyPin) valid = secretInfo.legacyPin === pin;
  if (!valid) {
    await recordRateFailure(rateKeys, 8, 10 * 60 * 1000);
    throw new HttpsError("invalid-argument", "이름 또는 PIN을 확인해주세요.");
  }
  if (!secretInfo.secret) {
    const hashed = await hashPassword(pin);
    const batch = db.batch();
    batch.set(secretInfo.ref, Object.assign({kind: "account", accountId: accountDoc.id}, hashed));
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
  return {
    name,
    nameKey: normalizeName(name),
    part,
    memberId,
    scoreAccessScope: "default",
    favorites: [],
    pinSet: true,
    createdAt: nowIso(),
    createdBy: actor,
    memberLinkedAt: memberId ? nowIso() : "",
    memberLinkedBy: memberId ? actor : "",
  };
}

async function assertUniqueNameKey(nameKey, excludeId, name) {
  const queries = [db.collection("accounts").where("nameKey", "==", nameKey).limit(3).get()];
  if (name) queries.push(db.collection("accounts").where("name", "==", cleanString(name, 60)).limit(3).get());
  const snaps = await Promise.all(queries);
  if (snaps.some((snap) => snap.docs.some((doc) => doc.id !== excludeId))) {
    throw new HttpsError("already-exists", "같은 이름의 계정이 이미 있습니다.");
  }
}

async function adminCreateAccount(request) {
  requirePermission(request, "account.manage");
  const pin = cleanString(request.data && request.data.pin, 12);
  if (!ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리여야 합니다.");
  const data = accountCreateData(request.data || {}, cleanString(request.auth.token.choirName, 60) || "관리자");
  await assertUniqueNameKey(data.nameKey, "", data.name);
  const ref = db.collection("accounts").doc();
  const secret = await hashPassword(pin);
  const batch = db.batch();
  batch.set(ref, data);
  batch.set(db.collection("authSecrets").doc(ref.id), Object.assign({kind: "account", accountId: ref.id}, secret));
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
    cleanString(item.currentLabel, 100), cleanString(item.linkedSongId, 100), linkedIds,
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
  const used = new Set(existing.docs.map((doc) => normalizeName((doc.data() || {}).name)));
  const prepared = [];
  for (const row of rows) {
    const pin = cleanString(row.pin, 12);
    if (!ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "모든 PIN은 숫자 4자리여야 합니다.");
    const data = accountCreateData(row, actor);
    if (used.has(data.nameKey)) throw new HttpsError("already-exists", data.name + " 계정이 중복됩니다.");
    used.add(data.nameKey);
    prepared.push({ref: db.collection("accounts").doc(), data, pin});
  }
  const secrets = await mapLimit(prepared, 4, async (item) => hashPassword(item.pin));
  for (let start = 0; start < prepared.length; start += 400) {
    const batch = db.batch();
    prepared.slice(start, start + 400).forEach((item, offset) => {
      const secret = secrets[start + offset];
      batch.set(item.ref, item.data);
      batch.set(db.collection("authSecrets").doc(item.ref.id), Object.assign({kind: "account", accountId: item.ref.id}, secret));
    });
    await batch.commit();
  }
  return {created: prepared.length, accounts: prepared.map((item) => safeProfile(item.ref.id, item.data))};
}

async function adminUpdateAccount(request) {
  const accountId = cleanString(request.data && request.data.accountId, 80);
  if (!accountId) throw new HttpsError("invalid-argument", "계정 ID가 필요합니다.");
  const ref = db.collection("accounts").doc(accountId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  const old = snap.data() || {};
  const mode = cleanString(request.data && request.data.mode, 20) || "profile";
  const update = {};
  if (mode === "profile") {
    requirePermission(request, "account.manage");
    update.name = cleanString(request.data.name, 60);
    update.part = cleanString(request.data.part, 30);
    update.memberId = cleanString(request.data.memberId, 80);
    if (!update.name || !update.part) throw new HttpsError("invalid-argument", "이름과 파트는 필수입니다.");
    update.nameKey = normalizeName(update.name);
    await assertUniqueNameKey(update.nameKey, accountId, update.name);
    update.memberLinkedAt = update.memberId ? nowIso() : "";
    update.memberLinkedBy = update.memberId ? (cleanString(request.auth.token.choirName, 60) || "관리자") : "";
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
  await ref.update(update);
  const next = Object.assign({}, old, update);
  await syncExistingAccountClaims(accountId, next);
  return {account: safeProfile(accountId, next)};
}

async function adminBulkLinkAccounts(request) {
  requirePermission(request, "account.manage");
  const rows = Array.isArray(request.data && request.data.rows) ? request.data.rows.slice(0, 300) : [];
  const actor = cleanString(request.auth.token.choirName, 60) || "관리자";
  const batch = db.batch();
  const changed = [];
  for (const row of rows) {
    const accountId = cleanString(row.accountId, 80);
    const memberId = cleanString(row.memberId, 80);
    if (!accountId || !memberId) continue;
    batch.update(db.collection("accounts").doc(accountId), {memberId, memberLinkedAt: nowIso(), memberLinkedBy: actor});
    changed.push({accountId, memberId});
  }
  if (changed.length) await batch.commit();
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
  if (!accountId || !ACCOUNT_PIN_PATTERN.test(pin)) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리여야 합니다.");
  const accountRef = db.collection("accounts").doc(accountId);
  if (!(await accountRef.get()).exists) throw new HttpsError("not-found", "계정을 찾을 수 없습니다.");
  const secret = await hashPassword(pin);
  const batch = db.batch();
  batch.set(db.collection("authSecrets").doc(accountId), Object.assign({kind: "account", accountId}, secret));
  batch.update(accountRef, {pin: FieldValue.delete(), pinSet: true, pinUpdatedAt: nowIso()});
  await batch.commit();
  try { await auth.revokeRefreshTokens(accountId); } catch (error) { if (!error || error.code !== "auth/user-not-found") throw error; }
  return {ok: true};
}

async function adminDeleteAccount(request) {
  requireAdmin(request);
  const accountId = cleanString(request.data && request.data.accountId, 80);
  if (!accountId) throw new HttpsError("invalid-argument", "계정 ID가 필요합니다.");
  const batch = db.batch();
  batch.delete(db.collection("accounts").doc(accountId));
  batch.delete(db.collection("authSecrets").doc(accountId));
  await batch.commit();
  try { await auth.deleteUser(accountId); } catch (error) { if (!error || error.code !== "auth/user-not-found") throw error; }
  return {ok: true};
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
    const secret = pin ? await hashPassword(pin) : null;
    if (pin) migrated++;
    return {doc, data, secret, hasSecret: secretSnap.exists || Boolean(secret)};
  });
  for (let start = 0; start < prepared.length; start += 300) {
    const batch = db.batch();
    prepared.slice(start, start + 300).forEach((item) => {
      const update = {nameKey: normalizeName(item.data.name), pin: FieldValue.delete(), pinSet: Boolean(item.hasSecret || item.data.pinSet), securityMigratedAt: nowIso()};
      batch.update(item.doc.ref, update);
      if (item.secret) batch.set(db.collection("authSecrets").doc(item.doc.id), Object.assign({kind: "account", accountId: item.doc.id}, item.secret));
    });
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

exports.authGateway = onCall(async (request) => {
  const action = cleanString(request.data && request.data.action, 40);
  if (action === "loginWithPin") return loginWithPin(request);
  if (action === "loginLegacyRole") return loginLegacyRole(request);
  if (action === "endElevatedSession") return endElevatedSession(request);
  if (action === "resetLegacyPassword") return resetLegacyPassword(request);
  throw new HttpsError("invalid-argument", "지원하지 않는 인증 요청입니다.");
});

exports.accountAdmin = onCall({timeoutSeconds: 120, memory: "512MiB"}, async (request) => {
  const action = cleanString(request.data && request.data.action, 40);
  if (action === "create") return adminCreateAccount(request);
  if (action === "bulkCreate") return adminBulkCreateAccounts(request);
  if (action === "update") return adminUpdateAccount(request);
  if (action === "bulkLink") return adminBulkLinkAccounts(request);
  if (action === "setPin") return adminSetAccountPin(request);
  if (action === "delete") return adminDeleteAccount(request);
  throw new HttpsError("invalid-argument", "지원하지 않는 계정 관리 요청입니다.");
});

exports.securityMaintenance = onCall({timeoutSeconds: 300, memory: "512MiB"}, async (request) => {
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
