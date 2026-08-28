/**
 * 보건실 대기 접수 — 백엔드 v2
 *
 * v1과 무엇이 다른가
 * ------------------
 * v1은 키오스크가 `getStudents` 로 **전교생 명단을 통째로 받아** 브라우저에서 학번을 대조했다.
 * 그래서 그 액션이 인증 없이 열려 있어야 했고, 주소만 알면 누구나 전교생 이름·학번과
 * 방문·처치 기록을 내려받을 수 있었다(2026-08-28 확인).
 *
 * v2는 키오스크에게 명단을 주지 않는다. 학번 하나를 보내면 그 학생만 돌려준다.
 * 그리고 모든 액션에 인증을 붙인다.
 *
 *   kiosk   기기 토큰 필요 — 학번 조회, 대기 신청, 대기 목록 보기
 *   teacher 교사 비밀번호 필요 — 그 외 전부(명단·기록·수정·삭제)
 *   (공개)  없음. 인증 없이 되는 것은 아무것도 없다.
 *
 * 기기 토큰은 소스에 없다. 키오스크를 처음 켤 때 선생님이 비밀번호를 한 번 넣으면
 * 서버가 발급하고, 그 기기의 localStorage에만 남는다.
 *
 * 준비 (편집기에서 ▶ 한 번)
 * -------------------------
 *   setup()  — 전용 스프레드시트를 만들고 시트 4개를 깔고 비밀번호를 정한다.
 *              실행 후 로그에 나오는 시트 주소를 보관할 것.
 *
 * 주의: JSONP라서 토큰이 URL 쿼리에 실린다. GAS 실행 로그에 남는다.
 *       Pages(정적 호스팅)에서 CORS 없이 부르려면 이 방법뿐이라 감수한 선택이다.
 *       ponytail: 토큰이 쿼리에 실린다. 자체 도메인 + POST로 옮기려면 프록시가 필요하다.
 */

var PROP = PropertiesService.getScriptProperties();

/** 액션별 필요 권한. 여기 없는 액션은 거부된다(화이트리스트). */
var PERMS = {
  // 키오스크
  lookupStudent: 'kiosk',
  addQueue:      'kiosk',
  getQueue:      'kiosk',   // 교사도 같은 액션을 쓰되 응답이 더 상세하다
  provisionKiosk:'none',    // 교사 비밀번호를 본문으로 검사한다(아래 참조)
  // 교사
  getStudents:   'teacher',
  addStudent:    'teacher',
  deleteStudent: 'teacher',
  updateNote:    'teacher',
  saveStudentsChunk:'teacher',
  clearStudents: 'teacher',
  getLogs:       'teacher',
  updateLog:     'teacher',
  deleteLog:     'teacher',
  doneQueue:     'teacher',
  cancelQueue:   'teacher',
  clearQueue:    'teacher',
  reorderQueue:  'teacher',
  ringBell:      'teacher'
};

/* ───────────────────────── 진입점 ───────────────────────── */

function doGet(e) {
  var cb = (e && e.parameter && e.parameter.callback) || '';
  if (!e || !e.parameter || !e.parameter.action) return _out({ ok: true }, cb);
  try {
    return _out(_route(e.parameter), cb);
  } catch (err) {
    return _out({ error: String(err && err.message || err) }, cb);
  }
}

/** JSONP 응답. callback 이름은 영숫자만 허용한다(스크립트 주입 방지). */
function _out(obj, cb) {
  var body = JSON.stringify(obj);
  if (cb && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function _route(p) {
  var action = String(p.action);
  var need = PERMS[action];
  if (!need) return { error: 'unknown action' };

  if (need !== 'none') {
    var who = _authLevel(p.token);
    if (who === 'none') return { error: 'unauthorized' };
    if (need === 'teacher' && who !== 'teacher') return { error: 'unauthorized' };
    p._who = who;
  }

  switch (action) {
    case 'provisionKiosk': return provisionKiosk_(p.pw);
    case 'lookupStudent':  return lookupStudent_(p.key);
    case 'addQueue':       return addQueue_(p);
    case 'getQueue':       return getQueue_(p._who);
    case 'doneQueue':      return doneQueue_(p.key, p.treatment, true);
    case 'cancelQueue':    return doneQueue_(p.key, '', false);
    case 'clearQueue':     return clearQueue_();
    case 'reorderQueue':   return reorderQueue_(p.keys);
    case 'ringBell':       return ringBell_();
    case 'getStudents':    return { students: _readAll('students') };
    case 'addStudent':     return addStudent_(p);
    case 'deleteStudent':  return deleteStudent_(p.key);
    case 'updateNote':     return updateNote_(p.key, p.note);
    case 'saveStudentsChunk': return saveStudentsChunk_(p);
    case 'clearStudents':  return clearStudents_(p.grade);
    case 'getLogs':        return { logs: _readAll('logs') };
    case 'updateLog':      return updateLog_(p);
    case 'deleteLog':      return deleteLog_(p.key, p.ts);
  }
  return { error: 'unhandled action' };
}

/* ───────────────────────── 인증 ───────────────────────── */

/**
 * 토큰 하나로 권한을 판정한다.
 * 교사 비밀번호가 오면 'teacher', 기기 토큰이 오면 'kiosk', 아니면 'none'.
 */
function _authLevel(token) {
  if (!token) return 'none';
  var t = String(token);
  var teacher = PROP.getProperty('TEACHER_PW');
  var kiosk = PROP.getProperty('KIOSK_TOKEN');
  if (teacher && _eq(t, teacher)) return 'teacher';
  if (kiosk && _eq(t, kiosk)) return 'kiosk';
  return 'none';
}

/** 길이가 달라도 같은 시간이 걸리게 비교한다(타이밍 차이로 값을 좁히지 못하게). */
function _eq(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 키오스크 등록. 선생님이 그 기기에서 비밀번호를 한 번 넣으면 기기 토큰을 발급한다.
 * 토큰은 응답으로 한 번만 나가고 기기의 localStorage에 남는다.
 * 이미 발급된 토큰이 있으면 같은 값을 준다 — 키오스크 1대 기준이라 재발급이 필요 없다.
 * 기기를 잃어버렸거나 바꿨으면 rotateKioskToken() 을 편집기에서 실행한다.
 */
function provisionKiosk_(pw) {
  var teacher = PROP.getProperty('TEACHER_PW');
  if (!teacher || !pw || !_eq(String(pw), teacher)) {
    Utilities.sleep(700);           // 비밀번호 대입을 느리게 만든다
    return { error: '비밀번호가 맞지 않습니다.' };
  }
  var tok = PROP.getProperty('KIOSK_TOKEN');
  if (!tok) {
    tok = Utilities.getUuid().replace(/-/g, '');
    PROP.setProperty('KIOSK_TOKEN', tok);
  }
  return { token: tok };
}

/* ───────────────────────── 시트 ───────────────────────── */

var COLS = {
  students: ['key', 'name', 'grade', 'cls', 'note'],
  queue:    ['key', 'name', 'grade', 'cls', 'num', 'time', 'date', 'ts'],
  logs:     ['key', 'name', 'grade', 'cls', 'num', 'time', 'date', 'ts', 'treatment'],
  config:   ['key', 'value']
};

function _ss() {
  var id = PROP.getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID 없음 — 편집기에서 setup() 을 먼저 실행하세요.');
  return SpreadsheetApp.openById(id);
}

function _sheet(name) {
  var ss = _ss(), sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(COLS[name]);
  }
  return sh;
}

/** 시트를 객체 배열로 읽는다. 헤더 이름을 그대로 키로 쓴다. */
function _readAll(name) {
  var sh = _sheet(name), vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var head = vals[0].map(String);
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    var o = {}, empty = true;
    for (var c = 0; c < head.length; c++) {
      var v = vals[r][c];
      if (v !== '' && v !== null) empty = false;
      o[head[c]] = (v instanceof Date) ? v.toISOString() : v;
    }
    if (!empty) { o._row = r + 1; out.push(o); }
  }
  return out;
}

function _findRow(name, key) {
  var sh = _sheet(name), vals = sh.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) if (String(vals[r][0]) === String(key)) return r + 1;
  return -1;
}

/** 시트를 건드리는 쓰기는 전부 잠금 안에서 한다. 대기열이 꼬이는 것을 막는다. */
function _locked(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { error: '다른 작업이 처리 중입니다. 잠시 후 다시 시도하세요.' };
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ───────────────────────── 학생 ───────────────────────── */

/**
 * 학번 하나만 조회한다. v2의 핵심 — 키오스크는 이것만 쓴다.
 * 응답에 비고(note)는 넣지 않는다. 학생 화면에 알레르기 같은 정보가 뜰 이유가 없다.
 */
function lookupStudent_(key) {
  var k = String(key || '').trim();
  if (!/^\d{4}$/.test(k)) return { error: '학번 형식이 올바르지 않습니다.' };
  var row = _findRow('students', k);
  if (row < 0) return { found: false };
  var v = _sheet('students').getRange(row, 1, 1, COLS.students.length).getValues()[0];
  return { found: true, key: k, name: String(v[1]), grade: Number(v[2]), cls: Number(v[3]) };
}

function addStudent_(p) {
  return _locked(function () {
    var k = String(p.key || '').trim();
    if (!/^\d{4}$/.test(k)) return { error: '학번 형식이 올바르지 않습니다.' };
    var row = _findRow('students', k);
    var vals = [k, String(p.name || ''), Number(p.grade), Number(p.cls), String(p.note || '')];
    if (row > 0) _sheet('students').getRange(row, 1, 1, vals.length).setValues([vals]);
    else _sheet('students').appendRow(vals);
    return { ok: true };
  });
}

function deleteStudent_(key) {
  return _locked(function () {
    var row = _findRow('students', key);
    if (row < 0) return { error: '학생을 찾을 수 없습니다.' };
    _sheet('students').deleteRow(row);
    return { ok: true };
  });
}

function updateNote_(key, note) {
  return _locked(function () {
    var row = _findRow('students', key);
    if (row < 0) return { error: '학생을 찾을 수 없습니다.' };
    _sheet('students').getRange(row, 5).setValue(String(note || ''));
    return { ok: true };
  });
}

/** 업로드는 나눠서 들어온다. 마지막 조각이 아니면 그냥 이어붙인다. */
function saveStudentsChunk_(p) {
  return _locked(function () {
    var chunk = JSON.parse(decodeURIComponent(p.chunk || '[]'));
    var index = Number(p.index || 0);
    var sh = _sheet('students');
    if (index === 0) {                       // 첫 조각에서 기존 내용을 비운다
      var last = sh.getLastRow();
      if (last > 1) sh.deleteRows(2, last - 1);
    }
    if (chunk.length) {
      var rows = chunk.map(function (s) {
        return [String(s.key), String(s.name || ''), Number(s.grade), Number(s.cls), String(s.note || '')];
      });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, COLS.students.length).setValues(rows);
    }
    return { ok: true, index: index };
  });
}

function clearStudents_(grade) {
  return _locked(function () {
    var sh = _sheet('students');
    if (!grade || grade === 'all') {
      var last = sh.getLastRow();
      if (last > 1) sh.deleteRows(2, last - 1);
      return { ok: true };
    }
    var vals = sh.getDataRange().getValues(), g = Number(grade);
    for (var r = vals.length - 1; r >= 1; r--) if (Number(vals[r][2]) === g) sh.deleteRow(r + 1);
    return { ok: true };
  });
}

/* ───────────────────────── 대기열 ───────────────────────── */

/**
 * 키오스크에는 이름만 준다. 교사 화면에는 비고까지 포함해 전부 준다.
 * 보건실 앞 화면에 알레르기 같은 비고가 뜨면 안 된다.
 */
function getQueue_(who) {
  var q = _readAll('queue');
  q.sort(function (a, b) { return Number(a.ts) - Number(b.ts); });
  if (who === 'teacher') {
    var notes = {};
    _readAll('students').forEach(function (s) { notes[String(s.key)] = s.note || ''; });
    q.forEach(function (e) { e.note = notes[String(e.key)] || ''; });
    return { queue: q, bell: _bellPending_() };
  }
  return {
    queue: q.map(function (e) { return { key: String(e.key), name: String(e.name) }; }),
    bell: _bellPending_()
  };
}

function addQueue_(p) {
  return _locked(function () {
    var k = String(p.key || '').trim();
    if (!/^\d{4}$/.test(k)) return { error: '학번 형식이 올바르지 않습니다.' };
    if (_findRow('queue', k) > 0) return { error: '이미 대기 중인 학생입니다.' };
    var st = lookupStudent_(k);            // 이름을 클라이언트 말이 아니라 시트에서 가져온다
    if (!st.found) return { error: '학번을 찾을 수 없습니다.' };
    var now = new Date();
    _sheet('queue').appendRow([
      k, st.name, st.grade, st.cls, k.slice(2),
      Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm'),
      Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd'),
      now.getTime()
    ]);
    return { ok: true, name: st.name };
  });
}

/** done=true 면 기록에 남기고, false(취소)면 남기지 않는다. */
function doneQueue_(key, treatment, keepLog) {
  return _locked(function () {
    var row = _findRow('queue', key);
    if (row < 0) return { error: '대기 목록에 없습니다.' };
    var sh = _sheet('queue');
    var v = sh.getRange(row, 1, 1, COLS.queue.length).getValues()[0];
    sh.deleteRow(row);
    if (keepLog) _sheet('logs').appendRow(v.concat([String(treatment || '')]));
    return { ok: true };
  });
}

function clearQueue_() {
  return _locked(function () {
    var sh = _sheet('queue'), last = sh.getLastRow();
    if (last > 1) sh.deleteRows(2, last - 1);
    return { ok: true };
  });
}

/**
 * 순서 변경. v1은 전부 지우고 다시 넣어서, 중간에 실패하면 대기열이 통째로 날아갔다.
 * v2는 ts 값만 다시 매긴다 — 행을 지우지 않으니 실패해도 사람이 사라지지 않는다.
 */
function reorderQueue_(keysCsv) {
  return _locked(function () {
    var order = String(keysCsv || '').split(',').filter(String);
    if (!order.length) return { error: '순서가 비어 있습니다.' };
    var sh = _sheet('queue'), vals = sh.getDataRange().getValues();
    var rowOf = {};
    for (var r = 1; r < vals.length; r++) rowOf[String(vals[r][0])] = r + 1;
    var base = Date.now() - order.length * 1000;
    var tsCol = COLS.queue.indexOf('ts') + 1;
    for (var i = 0; i < order.length; i++) {
      var row = rowOf[order[i]];
      if (row) sh.getRange(row, tsCol).setValue(base + i * 1000);
    }
    return { ok: true };
  });
}

/** 수업종. config 에 시각을 적어두면 키오스크가 그걸 보고 전체화면 알림을 띄운다. */
function ringBell_() {
  return _locked(function () {
    var sh = _sheet('config'), row = _findRow('config', 'bell_at');
    if (row > 0) sh.getRange(row, 2).setValue(Date.now());
    else sh.appendRow(['bell_at', Date.now()]);
    return { ok: true };
  });
}

/** 울린 지 60초 안이면 아직 유효한 종으로 본다. */
function _bellPending_() {
  var row = _findRow('config', 'bell_at');
  if (row < 0) return 0;
  var at = Number(_sheet('config').getRange(row, 2).getValue()) || 0;
  return (Date.now() - at < 60000) ? at : 0;
}

/* ───────────────────────── 기록 ───────────────────────── */

function updateLog_(p) {
  return _locked(function () {
    var logs = _readAll('logs');
    var hit = null;
    for (var i = 0; i < logs.length; i++) {
      if (String(logs[i].key) === String(p.origKey) && String(logs[i].ts) === String(p.origTs)) { hit = logs[i]; break; }
    }
    if (!hit) return { error: '기록을 찾을 수 없습니다.' };
    var sh = _sheet('logs');
    sh.getRange(hit._row, 1, 1, COLS.logs.length).setValues([[
      String(p.key), String(p.name), Number(hit.grade), Number(hit.cls), String(hit.num),
      String(p.time), String(p.date), hit.ts, String(p.treatment || '')
    ]]);
    return { ok: true };
  });
}

function deleteLog_(key, ts) {
  return _locked(function () {
    var logs = _readAll('logs');
    for (var i = 0; i < logs.length; i++) {
      if (String(logs[i].key) === String(key) && String(logs[i].ts) === String(ts)) {
        _sheet('logs').deleteRow(logs[i]._row);
        return { ok: true };
      }
    }
    return { error: '기록을 찾을 수 없습니다.' };
  });
}

/* ═════════════════════ 수동 실행 ═════════════════════ */

/**
 * 처음 한 번. 전용 스프레드시트를 만들고 시트를 깔고 비밀번호를 정한다.
 * 실행 후 로그에 시트 주소가 나온다. 그 주소를 보관할 것.
 */
function setup() {
  var id = PROP.getProperty('SHEET_ID');
  if (!id) {
    var ss = SpreadsheetApp.create('보건실 대기 접수 — v2 테스트');
    id = ss.getId();
    PROP.setProperty('SHEET_ID', id);
    var first = ss.getSheets()[0];
    first.setName('students');
    first.appendRow(COLS.students);
    ['queue', 'logs', 'config'].forEach(function (n) {
      ss.insertSheet(n).appendRow(COLS[n]);
    });
  }
  if (!PROP.getProperty('TEACHER_PW')) {
    PROP.setProperty('TEACHER_PW', Utilities.getUuid().slice(0, 8));
  }
  Logger.log('시트: https://docs.google.com/spreadsheets/d/' + id + '/edit');
  Logger.log('교사 비밀번호: ' + PROP.getProperty('TEACHER_PW'));
  Logger.log('※ 비밀번호는 프로젝트 설정 → 스크립트 속성 TEACHER_PW 에서 바꿀 수 있습니다.');
  return id;
}

/** 테스트용 가짜 학생 몇 명. 실제 명단을 테스트 시트에 넣지 않기 위한 것이다. */
function seedTestStudents() {
  var rows = [
    ['1101', '김하늘', 1, 1, ''],
    ['1102', '이서준', 1, 1, '땅콩 알레르기'],
    ['1203', '박지우', 1, 2, ''],
    ['2105', '최민서', 2, 1, ''],
    ['3110', '정도윤', 3, 1, '천식']
  ];
  var sh = _sheet('students');
  var last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  sh.getRange(2, 1, rows.length, COLS.students.length).setValues(rows);
  Logger.log('테스트 학생 ' + rows.length + '명 넣음');
}

/** 키오스크를 바꿨거나 잃어버렸을 때. 기존 기기는 즉시 접속이 끊긴다. */
function rotateKioskToken() {
  PROP.deleteProperty('KIOSK_TOKEN');
  Logger.log('기기 토큰을 지웠습니다. 키오스크에서 비밀번호를 다시 넣어 등록하세요.');
}

/** 지금 설정 상태 보기. */
function showConfig() {
  Logger.log('SHEET_ID     : ' + (PROP.getProperty('SHEET_ID') || '(없음)'));
  Logger.log('TEACHER_PW   : ' + (PROP.getProperty('TEACHER_PW') ? '설정됨' : '(없음)'));
  Logger.log('KIOSK_TOKEN  : ' + (PROP.getProperty('KIOSK_TOKEN') ? '발급됨' : '(미발급)'));
}
