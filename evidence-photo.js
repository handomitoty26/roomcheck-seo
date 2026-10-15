// 퇴실 체크아웃 벌점 증거 사진 — 촬영 처리·임시/확정·장수 한도·보관 기간·드라이브 올리기/지우기(태하관·서현관 앱 공통, 두 저장소에 바이트까지 같게)
//
// 사진 목록의 정본은 이 앱의 IndexedDB(앱별 이름)다 — localStorage 기록 JSON에는 넣지 않는다(같은 주소의 기숙사 앱 13개가 localStorage를 함께 쓰고,
// 백업 복원·두 창 저장이 기록 JSON을 통째로 바꾸기 때문). 사진 한 장 = photos 항목 하나 + blobs 항목 하나(같은 id).
// 상태: processing(받아서 처리 중) → draft(창 안 임시) → saved([저장]으로 확정) / failed(처리 실패) / deleting(드라이브 사본을 지우는 중).
(function (root) {
  "use strict";

  const MAX_PER_ENTRY = 2; // 벌점 입력 한 건(그날 학생 한 명 또는 호실 하나)에 사진 최대 장수
  const RESTORE_TTL_MS = 10 * 60 * 1000; // 카메라를 연 뒤 앱이 다시 시작됐을 때 창을 되살리는 시간
  const GALLERY_GAP_MS = 10 * 60 * 1000; // 파일 시각이 받은 시각과 이만큼 넘게 다르면 갤러리 사진으로 본다
  const LONG_EDGE = 1600;
  const JPEG_QUALITY = 0.82;
  const MIN_FREE_BYTES = 30 * 1024 * 1024;
  const STAMP_MAX_CHARS = 64;
  const DELETE_SETTLE_MS = 10 * 60 * 1000;
  const EXIF_SCAN_BYTES = 128 * 1024;
  const COUNTED = ["processing", "draft", "saved"]; // 장수에 세는 상태(실패·지우는 중은 세지 않음)
  const VISIBLE = ["processing", "draft", "saved", "failed"];

  // ---------- 순수 함수 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localTime = (d, sec) => `${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? ":" + pad(d.getSeconds()) : ""}`;
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

  // 찍은 날(YYYY-MM-DD)의 학기 끝 — 3~8월 → 그해 8/31, 9~12월 → 다음 해 2월 말일, 1~2월 → 그해 2월 말일(윤년 포함). 문자열로만 계산(UTC 변환 없음).
  function semesterEnd(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    if (mo >= 3 && mo <= 8) return `${y}-08-31`;
    const fy = mo >= 9 ? y + 1 : y;
    return `${fy}-02-${isLeap(fy) ? 29 : 28}`;
  }

  const cut = (s, n) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("") + "…" : s);

  // 사진 아래 띠 글자 두 줄 — 촬영 시각은 파일을 받은 순간의 실제 시계, 업무일 시트가 촬영 날짜와 다르면 "기록일"을 따로.
  // 벌점 항목은 넣지 않는다(찍은 뒤 항목을 바꿔 저장하면 고칠 수 없는 글자와 기록이 어긋나므로 — 항목은 파일 이름·엑셀·보기 창에 확정 항목으로).
  function stampLines({ takenAt, sheetDate, roomNo, targetLabel, supervisor }) {
    const t = new Date(takenAt);
    const sheet = sheetDate && sheetDate !== localDate(t) ? ` · 기록일 ${sheetDate.slice(5)}` : "";
    const line1 = `촬영 ${localDate(t)} ${localTime(t)}${sheet}`;
    const line2 = `${roomNo}호 · ${targetLabel} · 사감 ${supervisor || "-"}`;
    return [cut(line1, STAMP_MAX_CHARS), cut(line2, STAMP_MAX_CHARS)];
  }

  // JPEG의 EXIF 촬영 시각(DateTimeOriginal, 없으면 DateTimeDigitized — 기기 현지 시각)을 ms로. 없거나 읽을 수 없으면 null.
  function exifTakenMs(buf) {
    try {
      const v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return null;
      let o = 2;
      while (o + 10 <= v.byteLength) {
        const marker = v.getUint16(o);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
        if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) {
          const t = o + 10; // TIFF 머리
          const le = v.getUint16(t) === 0x4949;
          const u16 = (p) => v.getUint16(p, le);
          const u32 = (p) => v.getUint32(p, le);
          const tag = (ifd, id) => { const n = u16(t + ifd); for (let i = 0; i < n; i++) { const e = t + ifd + 2 + i * 12; if (u16(e) === id) return e; } return null; };
          const ptr = tag(u32(t + 4), 0x8769);
          if (ptr === null) return null;
          const ent = tag(u32(ptr + 8), 0x9003) ?? tag(u32(ptr + 8), 0x9004);
          if (ent === null) return null;
          const off = t + u32(ent + 8);
          let s = "";
          for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(off + i));
          const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
          if (!m) return null;
          const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
          return Number.isFinite(ms) ? ms : null;
        }
        o += 2 + v.getUint16(o + 2);
      }
    } catch (e) { /* 깨진 EXIF는 없는 것으로 */ }
    return null;
  }

  // 드라이브 파일 이름 — 날짜_호실_(학번|호실전체)_시각초_id앞6.jpg(학생 이름은 넣지 않음, 파일 이름으로 쓸 수 없는 글자는 _).
  // 벌점 항목은 넣지 않는다 — 나중에 벌점을 고쳐도 기록(엑셀 벌점 칸)과 어긋나지 않게(항목은 기록에만).
  function fileName({ takenAt, roomNo, key, id }) {
    const t = new Date(takenAt);
    const who = String(key || "").startsWith("stu:") ? String(key).slice(4) : "호실전체";
    const raw = `${localDate(t)}_${roomNo}호_${who}_${localTime(t, true).replace(/:/g, "")}_${String(id || "").slice(0, 6)}.jpg`;
    return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  }

  const canAddPhoto = (count) => Number.isInteger(count) && count >= 0 && count < MAX_PER_ENTRY;

  // 카메라를 열기 전 남긴 표시로 창을 되살릴지 — 모양이 맞고 10분 안이어야 한다.
  function shouldRestore(marker, nowMs) {
    if (!marker || typeof marker !== "object") return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(marker.date || ""))) return false;
    if (marker.kind !== "stu" && marker.kind !== "room") return false;
    if (!marker.target) return false;
    const at = Number(marker.at);
    return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= RESTORE_TTL_MS;
  }

  // 갤러리에서 고른 옛 사진으로 보이는지(파일 시각이 받은 시각과 10분 넘게 다름). 파일 시각이 없으면 판단하지 않는다.
  function isGalleryLike(fileTimeMs, receivedMs) {
    const f = Number(fileTimeMs);
    if (!Number.isFinite(f) || f <= 0) return false;
    return Math.abs(Number(receivedMs) - f) > GALLERY_GAP_MS;
  }

  const isExpired = (photo, todayStr) => photo.status === "saved" && !!photo.keepUntil && photo.keepUntil < todayStr;
  const countsTowardLimit = (photo) => COUNTED.includes(photo.status);
  const newId = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

  // ---------- IndexedDB ----------
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = tx.onerror = () => rej(tx.error || new Error("트랜잭션 실패")); });

  function openDb(name) {
    return new Promise((res, rej) => {
      const r = root.indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        const photos = db.createObjectStore("photos", { keyPath: "id" });
        photos.createIndex("byDate", "date");
        photos.createIndex("byDateKey", ["date", "key"]);
        db.createObjectStore("blobs", { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  function create(opts) {
    const appId = opts.appId;
    const markerKey = `${appId}-camera-pending`;
    let dbp = null;
    const db = () => (dbp ||= openDb(opts.dbName));
    let processChain = Promise.resolve();
    const listeners = new Set();
    const notify = (ev) => listeners.forEach((fn) => { try { fn(ev || {}); } catch (e) { /* 화면 갱신 실패는 무시 */ } });
    // 지운 사진의 "지우는 중" 표시를 남겨 두는 시간 — 응답을 잃은 올리기 파일이 드라이브 검색에 늦게 잡혀도 다음 작업에서 다시 찾아 지우게
    const settleMs = opts.deleteSettleMs ?? DELETE_SETTLE_MS;
    // 이 창이 열려 있는 동안 잡고 있는 잠금 — 다른 창(설치 앱과 크롬 탭 등)이 시작할 때 이 창의 저장 전 사진을 지우지 않게. 창이 닫히거나 죽으면 브라우저가 푼다.
    const instance = newId();
    const lockName = (inst) => `${appId}-open-${inst}`;
    try { root.navigator.locks.request(lockName(instance), () => new Promise(() => {})).catch(() => {}); } catch (e) { /* 잠금을 못 쓰면 예전처럼 시작 때 모두 정리 */ }

    async function all(filter) {
      const d = await db();
      const tx = d.transaction("photos", "readonly");
      const list = await req(tx.objectStore("photos").getAll());
      return filter ? list.filter(filter) : list;
    }
    const forDate = (date) => all((p) => p.date === date && VISIBLE.includes(p.status));
    const getBlob = async (id) => { const d = await db(); return (await req(d.transaction("blobs").objectStore("blobs").get(id)))?.blob || null; };

    // 받은 순간 자리를 잡는다(처리 중도 장수에 셈) — 같은 날짜·대상의 셈과 넣기가 한 트랜잭션이라 연달아 눌러도 2장을 넘지 않는다.
    async function reserve(meta) {
      const d = await db();
      const tx = d.transaction("photos", "readwrite");
      const store = tx.objectStore("photos");
      const same = await req(store.index("byDateKey").getAll([meta.date, meta.key]));
      if (!canAddPhoto(same.filter(countsTowardLimit).length)) { tx.abort(); throw new Error("LIMIT"); }
      const photo = { ...meta, status: "processing", drive: { state: "none", id: null } };
      store.put(photo);
      await done(tx);
      notify();
      return photo;
    }

    async function update(id, patch) {
      const d = await db();
      const tx = d.transaction("photos", "readwrite");
      const store = tx.objectStore("photos");
      const cur = await req(store.get(id));
      if (cur) store.put({ ...cur, ...patch, drive: { ...(cur.drive || {}), ...(patch.drive || {}) } });
      await done(tx);
      return !!cur;
    }

    async function removeNow(ids) {
      if (!ids.length) return;
      const d = await db();
      const tx = d.transaction(["photos", "blobs"], "readwrite");
      ids.forEach((id) => { tx.objectStore("photos").delete(id); tx.objectStore("blobs").delete(id); });
      await done(tx);
      notify();
    }

    // 사진을 줄이고 아래 띠에 글자를 넣은 JPEG(원본은 남기지 않음)
    async function render(file, lines) {
      let bmp;
      try { bmp = await root.createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (e) { bmp = await root.createImageBitmap(file); }
      const scale = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      let fs = Math.max(14, Math.round(w / 42));
      const band = Math.round(fs * 2.9);
      const canvas = root.document.createElement("canvas");
      canvas.width = w;
      canvas.height = h + band; // 띠는 사진 아래에 덧붙인다(사진을 가리지 않음)
      const g = canvas.getContext("2d");
      g.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      g.fillStyle = "#111";
      g.fillRect(0, h, w, band);
      g.fillStyle = "#fff";
      g.textBaseline = "top";
      const font = (n) => `bold ${n}px "Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo","Samsung Sans",sans-serif`;
      g.font = font(fs);
      while (fs > 10 && lines.some((l) => g.measureText(l).width > w - fs)) { fs -= 1; g.font = font(fs); }
      g.fillText(lines[0], Math.round(fs / 2), h + Math.round(fs * 0.35));
      g.fillText(lines[1], Math.round(fs / 2), h + Math.round(fs * 1.55));
      return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("JPEG 만들기 실패"))), "image/jpeg", JPEG_QUALITY));
    }

    async function sha256(blob) {
      const buf = await root.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function hasRoom() {
      try {
        const e = await root.navigator.storage.estimate();
        if (e && Number.isFinite(e.quota) && Number.isFinite(e.usage)) return e.quota - e.usage > MIN_FREE_BYTES;
      } catch (e) { /* 모르면 시도해 본다 */ }
      return true;
    }

    // 파일의 촬영 시각 — EXIF가 있으면 그것, 없으면 파일 시각(lastModified)
    async function fileTimeMs(file) {
      try { if (file && typeof file.slice === "function") { const ms = exifTakenMs(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer()); if (ms) return ms; } }
      catch (e) { /* 못 읽으면 파일 시각 */ }
      return file && file.lastModified;
    }

    // 파일을 받는다 — 바로 자리를 잡고(장수 한도), 처리는 한 장씩 뒤에서. 처리 결과(저장됨/실패)는 상태로 보인다.
    // ctx: {date, key, sheetDate, roomNo, targetLabel, items, supervisor, session, receivedAt(파일을 받은 순간 — 호스트가 change 첫 줄에서 잰 값)}
    async function addFile(file, ctx) {
      const receivedAt = Number.isFinite(ctx.receivedAt) ? ctx.receivedAt : Date.now();
      const shot = await fileTimeMs(file);
      const photo = await reserve({
        id: newId(), date: ctx.date, key: ctx.key, session: ctx.session, instance, items: ctx.items.slice(),
        takenAt: new Date(receivedAt).toISOString(), sheetDate: ctx.sheetDate, roomNo: ctx.roomNo,
        source: isGalleryLike(shot, receivedAt) ? "gallery" : "camera",
        keepUntil: semesterEnd(localDate(new Date(receivedAt))), hash: null, error: null,
      });
      const lines = stampLines({ takenAt: receivedAt, sheetDate: ctx.sheetDate, roomNo: ctx.roomNo, targetLabel: ctx.targetLabel, supervisor: ctx.supervisor });
      const job = processChain.then(async () => {
        try {
          if (!(await hasRoom())) throw new Error("NO_SPACE");
          const blob = await (opts.renderImage || render)(file, lines); // renderImage: 시험에서만 바꿔 끼움(node에는 캔버스가 없음)
          const hash = await sha256(blob);
          const d = await db();
          const tx = d.transaction(["photos", "blobs"], "readwrite");
          const cur = await req(tx.objectStore("photos").get(photo.id));
          if (!cur || cur.status !== "processing") { tx.abort(); return; } // 처리 중 버려짐(창 닫기)
          tx.objectStore("blobs").put({ id: photo.id, blob });
          // 처리 중에 [저장]이 눌렸으면(저장 예약) 바로 확정, 아니면 창 안 임시
          const pc = cur.pendingCommit;
          tx.objectStore("photos").put(pc
            ? { ...cur, status: "saved", key: pc.key, savedItems: pc.items, session: null, pendingCommit: null, hash }
            : { ...cur, status: "draft", hash });
          await done(tx);
          notify(pc ? { type: "saved" } : undefined); // 저장 예약이 확정되면 호스트가 드라이브 올리기를 잡는다
          return;
        } catch (e) {
          // 저장 예약(pendingCommit)이 걸린 채 실패하면 그 표시를 남겨 "저장하지 못한 사진"으로 사감이 확인할 때까지 보인다
          const code = e && (e.name === "QuotaExceededError" || e.message === "NO_SPACE") ? "NO_SPACE" : "FAILED";
          await update(photo.id, { status: "failed", error: code }).catch(() => {});
        }
        notify();
      });
      processChain = job.catch(() => {});
      return { photo, gallery: photo.source === "gallery", done: job };
    }

    // [저장] — 이 창에서 찍은 임시 사진을 확정한다(저장 시점의 대상·항목). 아직 처리 중인 사진은 "저장 예약"을 걸어 처리가 끝나면 확정되게 하고
    // (벌점 저장이 처리를 기다리지 않게), 처리에 실패한 사진도 저장 예약을 걸어 "저장하지 못한 사진"으로 남긴다(사감이 확인하면 지움).
    async function commit(session, key, items) {
      const d = await db();
      const tx = d.transaction("photos", "readwrite");
      const store = tx.objectStore("photos");
      const mine = (await req(store.getAll())).filter((p) => p.session === session);
      mine.forEach((p) => {
        if (p.status === "draft") store.put({ ...p, status: "saved", key, savedItems: items.slice(), session: null });
        else if (p.status === "processing" || p.status === "failed") store.put({ ...p, pendingCommit: { key, items: items.slice() } });
      });
      await done(tx);
      notify();
      return mine.filter((p) => p.status === "draft" || p.status === "processing").length;
    }

    // 저장하려 했지만 처리에 실패한 사진(사감에게 "다시 찍어 주세요"로 보이고, 확인하면 remove로 지운다)
    const unsavedFailures = () => all((p) => p.status === "failed" && !!p.pendingCommit);

    // 저장하지 않고 닫음 — 이 창의 임시 사진을 버린다(확정·지우는 중은 세션이 비어 있어도 건드리지 않는다).
    const UNSAVED = ["processing", "draft", "failed"];
    async function discard(session) {
      const mine = await all((p) => p.session === session && UNSAVED.includes(p.status));
      await removeNow(mine.map((p) => p.id));
      return mine.length;
    }
    const pendingInSession = (session) => all((p) => p.session === session && UNSAVED.includes(p.status)).then((l) => l.length);

    // 앱 시작 — 지난번에 남은 임시·처리 중·실패 사진을 버린다(저장하지 않은 창의 사진). 아직 열려 있는 다른 창의 사진은 남긴다.
    async function discardStale() {
      let live = new Set();
      try { live = new Set(((await root.navigator.locks.query()).held || []).map((l) => l.name)); } catch (e) { /* 잠금을 못 쓰면 모두 정리 */ }
      const stale = await all((p) => (p.status === "processing" || p.status === "draft" || (p.status === "failed" && !p.pendingCommit))
        && !(p.instance && p.instance !== instance && live.has(lockName(p.instance))));
      await removeNow(stale.map((p) => p.id));
      return stale.length;
    }

    // 지우기(잘못 찍음·벌점 취소·보관 종료) — 드라이브에 올라갔거나 올리는 중이면 "지우는 중"으로 두고 드라이브 작업이 지운 뒤 없앤다.
    async function remove(ids) {
      const list = await all((p) => ids.includes(p.id));
      const now = [];
      for (const p of list) {
        if (p.drive && (p.drive.id || p.drive.state === "uploading" || p.drive.state === "uploaded")) await update(p.id, { status: "deleting", deleteRequestedAt: Date.now() });
        else now.push(p.id);
      }
      await removeNow(now);
      notify();
      return { now: now.length, viaDrive: list.length - now.length };
    }

    const savedFor = (date, key) => all((p) => p.date === date && p.key === key && p.status === "saved");
    const savedAll = () => all((p) => p.status === "saved");
    const expired = (todayStr) => all((p) => isExpired(p, todayStr));

    async function summary() {
      const list = await all();
      return {
        saved: list.filter((p) => p.status === "saved").length,
        uploadWaiting: list.filter((p) => p.status === "saved" && (!p.drive || p.drive.state !== "uploaded")).length,
        deleteWaiting: list.filter((p) => p.status === "deleting").length,
      };
    }

    // ---------- 드라이브(호스트가 토큰을 확보한 뒤 한 줄의 작업 안에서 부른다) ----------
    // gFetch: 인증 머리를 붙여 주는 호스트 함수. 폴더는 백업 폴더 밖의 별도 폴더 — 이름과 이 앱 표시(appProperties.app)로 찾고 없으면 만든다
    // (두 기숙사 앱의 프로그램 제목이 같아도 폴더·사진이 섞이지 않게).
    async function syncDrive(gFetch) {
      const json = async (r) => { if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`); return r.status === 204 || r.status === 404 ? null : r.json(); };
      const q = (s) => encodeURIComponent(s);
      const mine = `appProperties has { key='app' and value='${appId}' }`;
      const name = opts.folderName();
      const safeName = name.replace(/'/g, "\\'");
      let found = await json(await gFetch(`https://www.googleapis.com/drive/v3/files?q=${q(`name='${safeName}' and mimeType='application/vnd.google-apps.folder' and ${mine} and trashed=false`)}&fields=files(id)`));
      let folderId = found && found.files && found.files[0] && found.files[0].id;
      if (!folderId) {
        const made = await json(await gFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", appProperties: { app: appId } }),
        }));
        folderId = made.id;
      }
      const byPhotoId = async (id) => {
        const r = await json(await gFetch(`https://www.googleapis.com/drive/v3/files?q=${q(`appProperties has { key='photoId' and value='${id}' } and ${mine} and trashed=false`)}&fields=files(id)`));
        return (r && r.files) || [];
      };
      const result = { uploaded: 0, deleted: 0, failed: 0 };

      // 1) 지우는 중 — 아는 id와 같은 photoId로 올라간 파일을 모두 지운다(404도 성공). 지우기를 누른 지 settleMs가 지난 뒤의 작업에서만 태블릿에서
      //    없앤다(응답을 잃은 올리기 파일이 검색에 늦게 잡혀도 그때까지 다시 찾아 지운다).
      for (const p of await all((x) => x.status === "deleting")) {
        try {
          const ids = new Set((await byPhotoId(p.id)).map((f) => f.id));
          if (p.drive && p.drive.id) ids.add(p.drive.id);
          for (const fid of ids) await json(await gFetch(`https://www.googleapis.com/drive/v3/files/${fid}`, { method: "DELETE" }));
          if (Date.now() - (Number(p.deleteRequestedAt) || 0) < settleMs) continue;
          await removeNow([p.id]);
          result.deleted += 1;
        } catch (e) { result.failed += 1; }
      }
      // 2) 확정됐는데 아직 안 올라간 사진 — 같은 photoId 파일이 이미 있으면 그 id를 쓰고, 없으면 새로 만든다(이름으로 덮어쓰지 않음).
      for (const p of await all((x) => x.status === "saved" && (!x.drive || x.drive.state !== "uploaded"))) {
        try {
          const existing = await byPhotoId(p.id);
          if (existing.length) { await update(p.id, { drive: { state: "uploaded", id: existing[0].id } }); result.uploaded += 1; continue; }
          // 올리기 표시를 본체 읽기보다 먼저 — 표시 뒤의 지우기는 "지우는 중"(본체 남음)이 되어 올린 뒤 드라이브 사본까지 지우고,
          // 표시 전에 지워졌으면 본체도 없어 올리지 않는다(올리면 태블릿이 모르는 파일이 드라이브에 남는다).
          await update(p.id, { drive: { state: "uploading" } });
          const blob = await getBlob(p.id);
          if (!blob) continue;
          const meta = { name: fileName(p), parents: [folderId], mimeType: "image/jpeg", appProperties: { photoId: p.id, app: appId } };
          const boundary = `rosa${Date.now().toString(16)}`;
          const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
            blob, `\r\n--${boundary}--`,
          ]);
          const made = await json(await gFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
            method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
          }));
          // 올리는 동안 "지우기"가 눌렸으면 상태는 지우는 중 그대로 — id만 남겨 다음 작업이 드라이브 사본까지 지운다(없어졌으면 아무것도 안 함)
          await update(p.id, { drive: { state: "uploaded", id: made.id } });
          result.uploaded += 1;
        } catch (e) { result.failed += 1; }
      }
      notify();
      return result;
    }

    // ---------- 저장 공간 ----------
    async function storageInfo() {
      const info = { persisted: null, usage: null, quota: null };
      try { info.persisted = await root.navigator.storage.persisted(); } catch (e) { /* 지원 안 함 */ }
      try { const e = await root.navigator.storage.estimate(); info.usage = e.usage; info.quota = e.quota; } catch (e) { /* 지원 안 함 */ }
      return info;
    }
    async function requestPersist() {
      try { return await root.navigator.storage.persist(); } catch (e) { return false; }
    }

    // ---------- 카메라를 열기 전 표시(앱이 다시 시작될 때 창 되살리기) ----------
    const markCamera = (m) => { try { root.localStorage.setItem(markerKey, JSON.stringify({ ...m, at: Date.now() })); } catch (e) { /* 표시 실패는 무시 */ } };
    const clearCamera = () => { try { root.localStorage.removeItem(markerKey); } catch (e) { /* 무시 */ } };
    function takeCameraMarker() {
      let m = null;
      try { m = JSON.parse(root.localStorage.getItem(markerKey)); } catch (e) { m = null; }
      clearCamera();
      return shouldRestore(m, Date.now()) ? m : null;
    }

    return {
      MAX_PER_ENTRY, addFile, commit, unsavedFailures, discard, discardStale, pendingInSession, remove, forDate, savedFor, savedAll, expired, summary,
      getBlob, syncDrive, storageInfo, requestPersist, markCamera, clearCamera, takeCameraMarker, newSession: newId,
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  const api = { create, semesterEnd, stampLines, exifTakenMs, fileName, canAddPhoto, shouldRestore, isGalleryLike, isExpired, countsTowardLimit, localDate, MAX_PER_ENTRY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EvidencePhoto = api;
})(typeof window !== "undefined" ? window : globalThis);
