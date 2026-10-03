"use strict";

const DEFAULT_DATES = ["2026-09-20", "2026-10-04", "2026-10-11", "2026-10-12", "2026-10-16"];

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function koreanToday() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function publishedPlans(data) {
  const source = Array.isArray(data.plans) ? data.plans : Array.isArray(data.rows) ? [data] : [];
  return source.filter(plan => plan && Array.isArray(plan.rows)).map((plan, i) => Object.assign({}, plan, {
    publicId: String(plan.publicId || (plan.sourcePlanId ? "plan:" + plan.sourcePlanId :
      "legacy:" + [plan.name || "", plan.title || "", plan.date || "", plan.program || "", String(i)].join("|"))),
  }));
}

function planSeats(plan) {
  if (!plan) return [];
  const seats = [].concat(plan.rows || [], plan.orchestraRows || []).flatMap(row => row.seats || []).filter(Boolean);
  const slots = plan.specialSlots || {};
  return seats.concat([slots.conductor, slots.accompanist], slots.staff || []).filter(Boolean);
}

function createHandler(deps) {
  const {db, HttpsError, requireAdmin, requirePermission, hasPermission, attendanceScopeForRequest,
    assertAttendanceScope, cleanString, isValidDocumentId, nowIso, isAdminRequest} = deps;
  const configRef = db.collection("settings").doc("rehearsalAttendance");
  const records = db.collection("rehearsalAttendance");

  function canRead(request) {
    if (!hasPermission(request, "attendance.view") && !hasPermission(request, "attendance.check")) {
      throw new HttpsError("permission-denied", "출결 조회 권한이 필요합니다.");
    }
  }

  function configValue(snap) {
    const data = snap.exists ? snap.data() || {} : {};
    return {dates: Array.isArray(data.dates) ? data.dates.filter(validDate).sort() : DEFAULT_DATES.slice(),
      planId: cleanString(data.planId, 1500), version: cleanString(data.version, 100)};
  }

  async function planData() {
    const snap = await db.collection("settings").doc("publishedSeatingPlan").get();
    return publishedPlans(snap.exists ? snap.data() || {} : {});
  }

  async function roster(plan) {
    const ids = [...new Set(planSeats(plan).map(seat => String(seat.memberId || "")).filter(isValidDocumentId))];
    if (ids.length > 400) throw new HttpsError("failed-precondition", "출석 대상이 400명을 초과했습니다.");
    const snaps = ids.length ? await db.getAll(...ids.map(id => db.collection("members").doc(id))) : [];
    return snaps.filter(snap => snap.exists).map(snap => {
      const m = snap.data() || {};
      return {id: snap.id, name: cleanString(m.name, 60), part: cleanString(m.part, 30),
        subPart: cleanString(m.subPart, 30), status: m.status || "active", noAtt: !!m.noAtt,
        startDate: cleanString(m.attendanceStartDate || m.createdAt, 40).slice(0, 10)};
    }).filter(m => m.status === "active" && m.part !== "명단제외" && !m.noAtt);
  }

  async function load(request) {
    canRead(request);
    const config = configValue(await configRef.get());
    const plans = await planData();
    const plan = plans.find(item => item.publicId === config.planId) || null;
    const members = await roster(plan);
    if (plan && config.dates.includes("2026-09-20") && isAdminRequest(request)) {
      await importSeptemberAttendance(config, members);
    }
    const docs = config.dates.length ? await db.getAll(...config.dates.map(date => records.doc(date))) : [];
    const sessions = {};
    docs.forEach(doc => {if (doc.exists) sessions[doc.id] = doc.data();});
    return {config, plan, plans: plans.map(item => ({id: item.publicId, name: item.name || item.title || "자리배치"})),
      members, sessions, today: koreanToday(), scope: attendanceScopeForRequest(request),
      canEdit: hasPermission(request, "attendance.check"), canManage: isAdminRequest(request)};
  }

  // One-way, one-time import. Existing rehearsal decisions always win.
  async function importSeptemberAttendance(config, members) {
    const target = records.doc("2026-09-20");
    await db.runTransaction(async tx => {
      const currentConfig = configValue(await tx.get(configRef));
      if (currentConfig.planId !== config.planId || !currentConfig.dates.includes("2026-09-20")) return;
      const snap = await tx.get(target);
      const latest = snap.exists ? snap.data() || {} : {};
      if (latest.afternoonImportedAt) return;
      const source = await tx.get(db.collection("attendance").doc("2026-09-20_오후"));
      if (!source.exists) return;
      const sourceRecords = (source.data() || {}).records || {};
      const next = Object.assign({}, latest.records || {});
      const eligible = members.filter(m => !validDate(m.startDate) || m.startDate <= "2026-09-20");
      let imported = 0;
      eligible.forEach(m => {
        if (!Object.prototype.hasOwnProperty.call(next, m.id) && ["출석", "지각"].includes(sourceRecords[m.id])) {
          next[m.id] = "출석";
          imported++;
        }
      });
      tx.set(target, Object.assign({}, latest, {date: "2026-09-20", planId: config.planId, records: next,
        memberIds: [...new Set((latest.memberIds || []).concat(eligible.map(m => m.id)))],
        afternoonImportedAt: nowIso(), afternoonImportedCount: imported, importSource: "2026-09-20_오후",
        updatedAt: latest.updatedAt || nowIso(), updatedBy: latest.updatedBy || "9/20 오후 출결 반영"}));
    });
  }

  async function configure(request) {
    requireAdmin(request);
    const input = request.data || {};
    if (!Array.isArray(input.dates) || !input.dates.length || input.dates.length > 60 || input.dates.some(date => !validDate(date))) {
      throw new HttpsError("invalid-argument", "리허설 날짜는 올바른 날짜로 1~60개 지정해주세요.");
    }
    const dates = [...new Set(input.dates)].sort();
    const planId = cleanString(input.planId, 1500);
    if (!(await planData()).some(plan => plan.publicId === planId)) {
      throw new HttpsError("failed-precondition", "기준으로 사용할 공개 배치도를 선택해주세요.");
    }
    const version = nowIso();
    await db.runTransaction(async tx => {
      const current = configValue(await tx.get(configRef));
      if (current.version !== (input.baselineVersion || "")) throw new HttpsError("aborted", "관리 설정이 변경됐습니다. 다시 불러와주세요.");
      tx.set(configRef, {dates, planId, version, updatedBy: "관리자"});
    });
    return {ok: true};
  }

  async function save(request) {
    requirePermission(request, "attendance.check");
    const input = request.data || {};
    if (!validDate(input.date) || input.date > koreanToday()) throw new HttpsError("invalid-argument", "지난 날짜 또는 오늘의 리허설만 체크할 수 있습니다.");
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 400) throw new HttpsError("invalid-argument", "변경할 출석을 확인해주세요.");
    const seen = new Set();
    const changes = input.changes.map(change => {
      if (!change || !isValidDocumentId(change.id) || seen.has(change.id) ||
          !["", "출석", "결석"].includes(change.status) || !["", "출석", "결석"].includes(change.baselineStatus)) {
        throw new HttpsError("invalid-argument", "출석 체크 정보가 올바르지 않습니다.");
      }
      seen.add(change.id);
      return {id: change.id, status: change.status, baselineStatus: change.baselineStatus};
    });
    await assertAttendanceScope(request, changes);
    const plans = await planData();
    const plan = plans.find(item => item.publicId === input.planId);
    if (!plan) throw new HttpsError("failed-precondition", "기준 공개 배치도를 다시 확인해주세요.");
    const members = (await roster(plan)).filter(m => !validDate(m.startDate) || m.startDate <= input.date);
    const allowed = new Set(members.map(m => m.id));
    if (changes.some(change => !allowed.has(change.id))) throw new HttpsError("permission-denied", "이 리허설의 출석 대상이 아닌 단원입니다.");
    const ref = records.doc(input.date);
    let result;
    await db.runTransaction(async tx => {
      const config = configValue(await tx.get(configRef));
      if (config.planId !== input.planId || !config.dates.includes(input.date)) throw new HttpsError("failed-precondition", "관리자가 지정한 날짜와 배치도를 다시 확인해주세요.");
      const published = await tx.get(db.collection("settings").doc("publishedSeatingPlan"));
      const currentPlan = publishedPlans(published.exists ? published.data() || {} : {}).find(item => item.publicId === input.planId);
      const signature = value => JSON.stringify(planSeats(value).map(seat => seat.memberId || "").sort());
      if (!currentPlan || signature(currentPlan) !== signature(plan)) throw new HttpsError("aborted", "배치도 인원이 변경됐습니다. 새로고침 후 다시 체크해주세요.");
      const snap = await tx.get(ref);
      const latest = snap.exists ? snap.data() || {} : {};
      const next = Object.assign({}, latest.records || {});
      changes.forEach(change => {
        if ((next[change.id] || "") !== change.baselineStatus && (next[change.id] || "") !== change.status) {
          throw new HttpsError("aborted", "같은 단원의 출석을 다른 사람이 변경했습니다. 새로고침 후 다시 체크해주세요.");
        }
        if (change.status) next[change.id] = change.status;
        else delete next[change.id];
      });
      result = Object.assign({}, latest, {date: input.date, planId: input.planId, records: next,
        memberIds: [...new Set((latest.memberIds || []).concat(members.map(m => m.id)))],
        updatedAt: nowIso(), updatedBy: isAdminRequest(request) ? "관리자" : cleanString(request.auth.token.choirName, 60)});
      tx.set(ref, result);
    });
    return {ok: true, session: result};
  }

  return async request => {
    const action = request.data && request.data.action;
    if (action === "rehearsalLoad") return load(request);
    if (action === "rehearsalConfigure") return configure(request);
    if (action === "rehearsalSave") return save(request);
    throw new HttpsError("invalid-argument", "지원하지 않는 리허설 출석 요청입니다.");
  };
}

module.exports = {createHandler, DEFAULT_DATES, validDate, koreanToday, publishedPlans, planSeats};
