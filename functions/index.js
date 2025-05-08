// index.js
// Firebase Cloud Functions for Payple 정기결제 (recurring billing)
// Install dependencies: firebase-admin, firebase-functions, node-fetch, cors

const admin = require('firebase-admin');
const functions = require('firebase-functions');
const fetch = require('node-fetch').default;
const cors = require('cors')({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// Temporary hardcoded test credentials (for testing only)
const PAYPLE_CST_ID   = "test";
const PAYPLE_CUST_KEY = "abcd1234567890";
const PAYPLE_REFERER  = "https://your-domain.com";
const API_BASE = 'https://democpay.payple.kr/php';

/**
 * Helper: partner-auth with Payple
 */
async function partnerAuth(workType = 'AUTH') {
  const body = {
    cst_id: PAYPLE_CST_ID,
    custKey: PAYPLE_CUST_KEY,
    PCD_PAY_TYPE: 'card'
  };
  if (workType === 'PUSERDEL') body.PCD_PAY_WORK = 'PUSERDEL';

  const res = await fetch(`${API_BASE}/auth.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': PAYPLE_REFERER
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

/**
 * 1) Get Payple Auth Token (HTTP)
 */
exports.getPaypleAuthToken = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const auth = await partnerAuth();
      // Payple returns result: 'success' or similar
      if (!auth.result || auth.result.toLowerCase() !== 'success') {
        return res.status(500).json({ error: 'Auth failed', details: auth });
      }
      // Map Payple's fields: JSON has cst_id, custKey, AuthKey
      res.json({
        PCD_CST_ID: auth.cst_id,
        PCD_CUST_KEY: auth.custKey,
        PCD_AUTH_KEY: auth.AuthKey
      });
    } catch (e) {
      console.error('Error in getPaypleAuthToken:', e);
      res.status(500).json({ error: e.message });
    }
  });
});

/**
 * 2) Callback from Payple after billing key registration & first payment
 */
// 2) Callback from Payple after billing key registration & first payment
exports.handleBillingCallback = functions.https.onRequest(async (req, res) => {
  const p = { ...req.query, ...req.body };
  const userId = p.userId;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  // Prepare response payload
  let reply = {};

  // Check payment result
  if (p.PCD_PAY_RST !== 'success') {
    reply.PCD_PAY_STATE = '01';
    reply.PCD_PAY_MSG   = p.PCD_PAY_MSG || 'Payment failed';
    return res
      .status(200)
      .set('Content-Type', 'application/json')
      .send(reply);
  }

  // On success, record in Firestore
  const billingKey = p.PCD_PAYER_ID;
  const nextBilling = admin.firestore.Timestamp.fromDate(
    new Date(new Date().setMonth(new Date().getMonth() + 1))
  );
  const orderId=  p.PCD_PAY_OID;

  await db.collection('subscriptions').doc(userId).set({
    billingKey: billingKey,
    status: 'active',
    planInterval: 'month',
    lastPaymentDate: admin.firestore.Timestamp.now(),
    nextBillingDate: nextBilling,
    orderId: orderId,
  }, { merge: true });

  // Build JSON reply for widget
  reply.PCD_PAY_STATE   = '00';
  reply.PCD_PAY_MSG     = 'Success';
  reply.PCD_PAYER_ID    = billingKey;
  reply.PCD_NEXT_BILL   = nextBilling.toDate().toISOString();

  return res
    .status(200)
    .set('Content-Type', 'application/json')
    .send(reply);
});

/**
 * 3) Trigger First Payment (callable)
 */
exports.triggerFirstPayment = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');

  const docRef = db.collection('subscriptions').doc(uid);
  const subSnap = await docRef.get();
  const sub = subSnap.data();
  if (!sub?.billingKey) throw new functions.https.HttpsError('failed-precondition', 'No billing key');

  const authData = await partnerAuth();
  if (!authData.result || authData.result.toLowerCase() !== 'success') {
    throw new functions.https.HttpsError('internal', 'Auth failed', authData);
  }

  const payRes = await fetch(`${API_BASE}/SimplePayCardAct.php?ACT_=PAYM`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': PAYPLE_REFERER },
    body: JSON.stringify({
      PCD_CST_ID: authData.cst_id,
      PCD_CUST_KEY: authData.custKey,
      PCD_AUTH_KEY: authData.AuthKey,
      PCD_PAY_TYPE: 'card',
      PCD_PAYER_ID: sub.billingKey,
      PCD_PAY_GOODS: 'Subscription (1 month)',
      PCD_PAY_TOTAL: String(sub.planPrice),
      PCD_SIMPLE_FLAG: 'Y'
    })
  });
  const payJson = await payRes.json();
  if (!payJson.result || payJson.result.toLowerCase() !== 'success') {
    throw new functions.https.HttpsError('internal', 'Payment failed', payJson);
  }

  const next = admin.firestore.Timestamp.fromDate(
    new Date(new Date().setMonth(new Date().getMonth() + 1))
  );
  await docRef.update({ nextBillingDate: next });
  return { status: 'charged', nextBillingDate: next };
});

/**
 * 4) Renewal Endpoint (HTTP)
 */
exports.renewMonthlySubscriptions = functions.https.onRequest(async (req, res) => {
  const now = admin.firestore.Timestamp.now();
  const snap = await db.collection('subscriptions')
    .where('status', '==', 'active')
    .where('nextBillingDate', '<=', now)
    .get();

  const results = [];
  for (const doc of snap.docs) {
    const { billingKey, planPrice } = doc.data();
    const authData = await partnerAuth();
    if (!authData.result || authData.result.toLowerCase() !== 'success') continue;

    const payRes = await fetch(`${API_BASE}/SimplePayCardAct.php?ACT_=PAYM`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': PAYPLE_REFERER },
      body: JSON.stringify({
        PCD_CST_ID: authData.cst_id,
        PCD_CUST_KEY: authData.custKey,
        PCD_AUTH_KEY: authData.AuthKey,
        PCD_PAY_TYPE: 'card',
        PCD_PAYER_ID: billingKey,
        PCD_PAY_GOODS: 'Subscription (1 month)',
        PCD_PAY_TOTAL: String(planPrice),
        PCD_SIMPLE_FLAG: 'Y'
      })
    });
    const payJson = await payRes.json();
    if (payJson.result && payJson.result.toLowerCase() === 'success') {
      const next = admin.firestore.Timestamp.fromDate(
        new Date(new Date().setMonth(new Date().getMonth() + 1))
      );
      await doc.ref.update({ nextBillingDate: next });
      results.push({ id: doc.id, status: 'renewed' });
    } else {
      await doc.ref.update({ status: 'payment_failed' });
      results.push({ id: doc.id, status: 'failed' });
    }
  }
  res.json({ processed: results.length, details: results });
});

/**
 * 5) Cancel Subscription (callable)
 */
exports.cancelSubscription = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');

  const docRef = db.collection('subscriptions').doc(uid);
  const subSnap = await docRef.get();
  const sub = subSnap.data();
  if (sub?.status !== 'active') throw new functions.https.HttpsError('failed-precondition', 'No active subscription');

  const authData = await partnerAuth('PUSERDEL');
  if (!authData.result || authData.result.toLowerCase() !== 'success') {
    throw new functions.https.HttpsError('internal', 'Cancel auth failed', authData);
  }

  const cancelRes = await fetch(`${API_BASE}/cPayUser/api/cPayUserAct.php?ACT_=PUSERDEL`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': PAYPLE_REFERER },
    body: JSON.stringify({
      PCD_CST_ID: authData.cst_id,
      PCD_CUST_KEY: authData.custKey,
      PCD_AUTH_KEY: authData.AuthKey,
      PCD_PAYER_ID: sub.billingKey
    })
  });
  const cancelJson = await cancelRes.json();
  if (!cancelJson.result || cancelJson.result.toLowerCase() !== 'success') {
    throw new functions.https.HttpsError('internal', 'Cancel failed', cancelJson);
  }

  await docRef.update({ status: 'canceled' });
  return { status: 'canceled' };
});
