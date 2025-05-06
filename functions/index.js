// index.js
// Firebase Cloud Functions for Payple 정기결제 (recurring billing)
// Install dependencies: firebase-admin, firebase-functions, node-fetch

const admin = require('firebase-admin');
const functions = require('firebase-functions');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// Environment variables (set via `firebase functions:config:set payple.cst_id=... payple.cust_key=... payple.referer=...`)
const PAYPLE_CST_ID  = "test";
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
    PCD_PAY_TYPE: 'card',
    ...(workType === 'PUSERDEL' && { PCD_PAY_WORK: 'PUSERDEL' })
  };

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
 * 1) Get Payple Auth Token (callable)
 */
const cors = require('cors')({ origin: true });

exports.getPaypleAuthToken = functions.https.onRequest(async (req, res) => {
  // allow CORS so your browser page can call it
  cors(req, res, async () => {
    try {
      const auth = await partnerAuth();
      if (auth.result !== 'SUCCESS') {
        return res.status(500).json({ error: 'Auth failed', details: auth });
      }
      // only send what you need
      res.json({
        PCD_CST_ID: auth.PCD_CST_ID,
        PCD_CUST_KEY: auth.PCD_CUST_KEY,
        PCD_AUTH_KEY: auth.PCD_AUTH_KEY
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });
});

/**
 * 2) Callback from Payple after billing key registration & first payment
 */
exports.handleBillingCallback = functions.https.onRequest(async (req, res) => {
  const p = { ...req.query, ...req.body };
  const userId = p.userId;
  if (!userId) return res.status(400).send('Missing userId');

  if (p.PCD_PAY_RESULT !== 'success') {
    const errMsg = encodeURIComponent(p.PCD_PAY_MSG || 'Payment failed');
    return res.status(200).send(
      `<script>window.location.href="paymentresult://callback?status=fail&error=${errMsg}";</script>`
    );
  }

  const billingKey = p.PCD_PAYER_ID;
  const paidAmount = Number(p.PCD_PAY_TOTAL || 0);
  const nextBilling = admin.firestore.Timestamp.fromDate(
    new Date(new Date().setMonth(new Date().getMonth() + 1))
  );

  await db.collection('subscriptions').doc(userId).set({
    billingKey,
    status: 'active',
    planPrice: paidAmount,
    planInterval: 'month',
    lastPaymentDate: admin.firestore.Timestamp.now(),
    nextBillingDate: nextBilling
  }, { merge: true });

  const qs = `status=success&amount=${paidAmount}&nextBillingDate=${encodeURIComponent(nextBilling.toDate().toISOString())}`;
  res.status(200).set('Content-Type', 'text/html')
     .send(`<script>window.location.href="paymentresult://callback?${qs}";</script>`);
});

/**
 * 3) Trigger First Payment (callable) - optional if using CERT
 */
exports.triggerFirstPayment = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');

  const docRef = db.collection('subscriptions').doc(uid);
  const subSnap = await docRef.get();
  const sub = subSnap.data();
  if (!sub?.billingKey) throw new functions.https.HttpsError('failed-precondition', 'No billing key');

  const authData = await partnerAuth();
  if (authData.result !== 'SUCCESS') throw new functions.https.HttpsError('internal', 'Auth failed');

  const payRes = await fetch(`${API_BASE}/SimplePayCardAct.php?ACT_=PAYM`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json','Referer': PAYPLE_REFERER},
    body: JSON.stringify({
      PCD_CST_ID: authData.PCD_CST_ID,
      PCD_CUST_KEY: authData.PCD_CUST_KEY,
      PCD_AUTH_KEY: authData.PCD_AUTH_KEY,
      PCD_PAY_TYPE: 'card',
      PCD_PAYER_ID: sub.billingKey,
      PCD_PAY_GOODS: 'Subscription (1 month)',
      PCD_PAY_TOTAL: String(sub.planPrice),
      PCD_SIMPLE_FLAG: 'Y'
    })
  });
  const payJson = await payRes.json();
  if (payJson.result !== 'success') {
    throw new functions.https.HttpsError('internal', 'Payment failed', payJson);
  }

  const next = admin.firestore.Timestamp.fromDate(
    new Date(new Date().setMonth(new Date().getMonth() + 1))
  );
  await docRef.update({ nextBillingDate: next });
  return { status: 'charged', nextBillingDate: next };
});

/**
 * 4) Renewal Endpoint (HTTP) - call this from Cloud Scheduler
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
    if (authData.result !== 'SUCCESS') continue;

    const payRes = await fetch(`${API_BASE}/SimplePayCardAct.php?ACT_=PAYM`, {
      method: 'POST',headers: {'Content-Type': 'application/json','Referer': PAYPLE_REFERER},
      body: JSON.stringify({
        PCD_CST_ID: authData.PCD_CST_ID,
        PCD_CUST_KEY: authData.PCD_CUST_KEY,
        PCD_AUTH_KEY: authData.PCD_AUTH_KEY,
        PCD_PAY_TYPE: 'card',
        PCD_PAYER_ID: billingKey,
        PCD_PAY_GOODS: 'Subscription (1 month)',
        PCD_PAY_TOTAL: String(planPrice),
        PCD_SIMPLE_FLAG: 'Y'
      })
    });
    const payJson = await payRes.json();
    if (payJson.result === 'success') {
      const next = admin.firestore.Timestamp.fromDate(new Date(new Date().setMonth(new Date().getMonth() + 1)));
      await doc.ref.update({ nextBillingDate: next });
      results.push({ id: doc.id, status: 'renewed' });
    } else {
      await doc.ref.update({ status: 'payment_failed' });
      results.push({ id: doc.id, status: 'failed' });
    }
  }
  res.send({ processed: results.length, details: results });
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
  if (authData.result !== 'SUCCESS') throw new functions.https.HttpsError('internal', 'Cancel auth failed');

  const cancelRes = await fetch(`${API_BASE}/cPayUser/api/cPayUserAct.php?ACT_=PUSERDEL`, {
    method: 'POST', headers: {'Content-Type': 'application/json','Referer': PAYPLE_REFERER},
    body: JSON.stringify({
      PCD_CST_ID: authData.PCD_CST_ID,
      PCD_CUST_KEY: authData.PCD_CUST_KEY,
      PCD_AUTH_KEY: authData.PCD_AUTH_KEY,
      PCD_PAYER_ID: sub.billingKey
    })
  });
  const cancelJson = await cancelRes.json();
  if (cancelJson.result !== 'success') {
    throw new functions.https.HttpsError('internal', 'Cancel failed', cancelJson);
  }

  await docRef.update({ status: 'canceled' });
  return { status: 'canceled' };
});
