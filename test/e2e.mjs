// End-to-end API check. Needs the server running and fresh seed data (npm run test:e2e does the seeding).
const B = 'http://localhost:5000/api';
let fails = 0;
async function call(method, path, token, body) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`, cond ? '' : JSON.stringify(extra));
  if (!cond) fails++;
}

const c = (await call('POST', '/auth/login', null, { phone: '9000000001', password: 'demo123' })).data.token;
check('contractor login', !!c);

let r = await call('GET', '/contractor/dashboard', c);
check('dashboard counts', r.data.counts.pendingWorkers === 1 && r.data.counts.flagged === 1, r.data);

await call('PATCH', '/contractor/settings', c, { spotCheckNew: 0, spotCheckTrusted: 0 });

// New worker registers with join code
r = await call('POST', '/auth/register/worker', null, {
  name: 'Test Mistri', phone: '9111111111', password: 'secret1', joinCode: 'shiva1', trade: 'carpenter',
  skill: { experienceYears: 11, tools: ['a', 'b', 'c'], workTypes: ['x', 'y'], canReadDrawings: true, canLeadTeam: true },
});
check('worker registers, level suggested', r.status === 201 && r.data.user.suggestedLevel === 'head_mistri', r.data);
const w = r.data.token;
const wid = r.data.user._id;

r = await call('POST', '/attendance/check-in', w, { lat: 12.9698, lng: 77.75 });
check('pending worker cannot check in', r.status === 403, r);

r = await call('POST', '/auth/register/worker', null, { name: 'X', phone: '9222222222', password: 'secret1', joinCode: 'NOPE00', trade: 'painter' });
check('wrong join code rejected', r.status === 404);

const sites = (await call('GET', '/sites', c)).data.sites;
r = await call('POST', `/workers/${wid}/approve`, c, { level: 'skilled', dailyWage: 1100, siteId: sites[0]._id });
check('contractor approves with adjusted wage', r.data.worker?.status === 'active' && r.data.worker.dailyWage === 1100 && r.data.worker.workerCode === 'US-0003', r.data);

r = await call('POST', '/attendance/check-in', w, { lat: 12.9699, lng: 77.7501 });
check('check-in needs location consent first', r.status === 428, r.data);
r = await call('PATCH', '/auth/me', w, { locationConsent: true });
check('consent saved', !!r.data.user?.locationConsentAt, r.data);

r = await call('POST', '/attendance/check-in', w, { lat: 12.99, lng: 77.75 });
check('check-in far from site blocked', r.status === 400 && /away/.test(r.data.message), r.data);

r = await call('POST', '/attendance/check-in', w, { lat: 12.9699, lng: 77.7501, accuracy: 10 });
check('Hazri lagao inside geofence', r.status === 201, r.data);
r = await call('POST', '/attendance/check-in', w, { lat: 12.9699, lng: 77.7501 });
check('double check-in blocked', r.status === 400);

// --- Photos ---
const fakeJpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');
r = await call('POST', '/photos', w, { data: 'data:image/jpeg;base64,' + Buffer.from('not an image at all').toString('base64'), kind: 'progress' });
check('fake image rejected', r.status === 400, r.data);
r = await call('POST', '/photos', w, { data: fakeJpeg, kind: 'progress' });
check('progress photo uploaded', r.status === 201 && /^[a-f0-9]{24}$/.test(r.data.key), r.data);
const progressKey = r.data.key;
const ravi = (await call('POST', '/auth/login', null, { phone: '9000000002', password: 'demo123' })).data.token;
const raviPhoto = (await call('POST', '/photos', ravi, { data: fakeJpeg, kind: 'progress' })).data.key;
const img = await fetch(`${B}/photos/${progressKey}`);
check('photo served as image', img.status === 200 && img.headers.get('content-type') === 'image/jpeg');

r = await call('POST', '/attendance/check-out', w, { lat: 12.9699, lng: 77.7501, workNote: 'Kitchen shutters fitted', photoKeys: [progressKey, raviPhoto] });
check('short day gets flagged', r.data.record?.status === 'flagged' && r.data.record.flags.includes('too_few_hours'), r.data);
check('own photo accepted, other worker photo ignored', r.data.record?.photos?.length === 1 && r.data.record.photos[0] === progressKey && !r.data.record.flags.includes('no_progress_photo'), r.data.record);
const attId = r.data.record._id;

r = await call('POST', `/attendance/${attId}/correction`, w, { message: 'Material came late, left early' });
check('worker sends correction', r.status === 200);

r = await call('POST', `/attendance/${attId}/review`, c, { decision: 'approve' });
check('contractor approves flagged day', r.data.record?.dayValue === 1, r.data);

r = await call('GET', '/workers/me/summary', w);
check('ledger shows earned 1100', r.data.ledger?.earned === 1100 && r.data.ledger.availableToRequest === 3100, r.data);

r = await call('POST', '/money/requests', w, { amount: 5000, type: 'advance' });
check('request above limit blocked', r.status === 400, r.data);
r = await call('POST', '/money/requests', w, { amount: 1500, type: 'advance', reason: 'Room rent' });
check('money request sent', r.status === 201, r.data);
const reqId = r.data.request._id;
r = await call('POST', '/money/requests', w, { amount: 100 });
check('only one open request', r.status === 400);

r = await call('GET', '/money/requests?status=pending', c);
check('contractor sees request with ledger', r.data.requests.some((x) => x._id === reqId && x.ledger?.earned === 1100), r.data);

r = await call('POST', `/money/requests/${reqId}/decide`, c, { decision: 'approve', amount: 1200 });
check('partly approved', r.data.request?.approvedAmount === 1200);

// Needs real MongoDB (local or Atlas): atomic findOneAndUpdate + unique partial index on payment.request.
// Some MongoDB-compatible test databases (e.g. FerretDB) don't guarantee this, so this check can fail there.
const [p1, p2] = await Promise.all([
  call('POST', `/money/requests/${reqId}/pay`, c, { method: 'upi' }),
  call('POST', `/money/requests/${reqId}/pay`, c, { method: 'upi' }),
]);
check('double pay prevented (atomic)', [p1.status, p2.status].sort().join() === '200,409', [p1.status, p2.status]);
const payId = (p1.status === 200 ? p1 : p2).data.payment._id;

r = await call('POST', `/money/payments/${payId}/confirm`, w);
check('worker confirms Received', r.data.payment?.status === 'confirmed');

r = await call('POST', '/money/payments', c, { workerId: wid, amount: 300, note: 'tea' });
const p3 = r.data.payment._id;
r = await call('POST', `/money/payments/${p3}/dispute`, w, { reason: 'Never got this' });
check('worker disputes wrong entry', r.data.payment?.status === 'disputed');

r = await call('GET', '/workers/me/summary', w);
check('disputed payment not counted: balance -100', r.data.ledger.balance === -100 && r.data.ledger.advanceOutstanding === 100, r.data.ledger);

const profileKey = (await call('POST', '/photos', w, { data: fakeJpeg, kind: 'profile' })).data.key;
r = await call('PATCH', '/auth/me', w, { photoKey: profileKey });
check('profile photo set', r.data.user?.photoKey === profileKey, r.data);
r = await call('PATCH', '/auth/me', w, { photoKey: raviPhoto });
check('cannot use someone else photo as profile', r.status === 400);

r = await call('GET', '/workers/me/idcard', w);
check('ID card data with photo', !!r.data.card?.verifyUrl && r.data.card.photoKey === profileKey, r.data);
const token = r.data.card.verifyUrl.split('/').pop();
r = await call('GET', `/verify/${token}`);
check('QR verify active with photo', r.data.status === 'active' && r.data.worker.photoKey === profileKey, r.data);

await call('PATCH', `/workers/${wid}`, c, { status: 'inactive' });
r = await call('GET', `/verify/${token}`);
check('QR shows inactive after removal', r.data.status === 'inactive', r.data);
await call('PATCH', `/workers/${wid}`, c, { status: 'active' });
await call('POST', `/workers/${wid}/reissue-id`, c);
r = await call('GET', `/verify/${token}`);
check('old QR shows replaced after reissue', r.data.status === 'replaced', r.data);
r = await call('GET', `/verify/${token.slice(0, -3)}abc`);
check('forged QR rejected', r.data.status === 'invalid');

r = await call('GET', '/money/weekly', c);
check('weekly summary', r.data.rows?.length === 3, r.data);

r = await call('GET', '/workers', w);
check('worker cannot use contractor routes', r.status === 403);

// --- Step 1 fixes ---
// Manual attendance by contractor (phone dead etc.)
const suresh = (await call('GET', '/workers?status=active', c)).data.workers.find((x) => x.name === 'Suresh Gowda');
r = await call('POST', '/attendance/manual', c, { workerId: suresh._id, hours: 11, reason: 'Phone not working' });
check('manual attendance with overtime', r.status === 201 && r.data.record.manual && r.data.record.dayValue === 1 && r.data.record.overtimeHours === 2 && r.data.record.overtimePay === 200, r.data);
r = await call('POST', '/attendance/manual', c, { workerId: suresh._id, hours: 8, reason: 'again' });
check('manual attendance twice same day blocked', r.status === 409, r.data);
r = await call('POST', '/attendance/manual', c, { workerId: suresh._id, hours: 8, reason: 'x', date: '2999-01-01' });
check('manual attendance in future blocked', r.status === 400);

// Monthly report CSV
const rep = await fetch(`${B}/contractor/report?type=summary`, { headers: { Authorization: `Bearer ${c}` } });
const bytes = Buffer.from(await rep.arrayBuffer());
const csv = bytes.toString('utf8');
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf; // Excel needs this to show ₹ / Hindi
check('summary report CSV', rep.headers.get('content-type').includes('text/csv') && csv.includes('Suresh Gowda') && hasBom, csv.slice(0, 120));
const rep2 = await fetch(`${B}/contractor/report?type=attendance`, { headers: { Authorization: `Bearer ${c}` } });
check('attendance report CSV', (await rep2.text()).includes('Phone not working'));

// Contractor resets a worker's forgotten password
r = await call('POST', `/workers/${wid}/reset-password`, c);
check('contractor resets password', /^\d{6}$/.test(r.data.tempPassword || ''), r.data);
const temp = r.data.tempPassword;
r = await call('GET', '/auth/me', w);
check('old token logged out after reset', r.status === 401);
let w2 = (await call('POST', '/auth/login', null, { phone: '9111111111', password: temp })).data.token;
check('login with temporary password', !!w2);

// Worker changes own password → other sessions logged out
r = await call('POST', '/auth/change-password', w2, { oldPassword: 'wrong', newPassword: 'newpass1' });
check('change password needs old password', r.status === 400);
r = await call('POST', '/auth/change-password', w2, { oldPassword: temp, newPassword: 'newpass1' });
check('password changed, new token given', !!r.data.token, r.data);
const oldW2 = w2;
w2 = r.data.token;
check('previous session logged out', (await call('GET', '/auth/me', oldW2)).status === 401);

// Worker changes contractor
const other = (await call('POST', '/auth/register/contractor', null, { name: 'Raju', phone: '9444444444', password: 'secret1', companyName: 'Raju Interiors' })).data;
r = await call('POST', '/workers/me/join', w2, { joinCode: other.user.joinCode });
check('must leave before joining new contractor', r.status === 400);
r = await call('POST', '/workers/me/leave', w2);
check('worker leaves contractor', r.data.user?.status === 'inactive', r.data);
r = await call('POST', '/workers/me/join', w2, { joinCode: other.user.joinCode });
check('worker joins new contractor as pending', r.data.user?.status === 'pending' && !r.data.user.workerCode, r.data);
r = await call('GET', '/workers/me/history', w2);
check('work history keeps old job', r.data.jobs?.[0]?.companyName === 'Shiva Build Mart' && r.data.jobs[0].days === 1, r.data);
r = await call('POST', `/workers/${wid}/approve`, other.token, { dailyWage: 900 });
check('new contractor approves, new code', r.data.worker?.workerCode === 'US-0001', r.data);
r = await call('GET', '/workers/me/summary', w2);
check('ledger is fresh with new contractor', r.data.ledger?.earned === 0 && r.data.ledger.paid === 0, r.data);
r = await call('GET', `/workers/${wid}`, c);
check('old contractor no longer controls worker', r.status === 404);
r = await call('POST', '/auth/register/worker', null, { name: 'Dup', phone: '9111111111', password: 'secret1', joinCode: 'SHIVA1', trade: 'painter' });
check('same phone cannot register twice', r.status === 409);

// Privacy page
const priv = await fetch('http://localhost:5000/privacy');
check('privacy page', priv.status === 200 && (await priv.text()).includes('only at the moment you check in'));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
