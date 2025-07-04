// index.js
// Firebase Cloud Functions for Payple 정기결제 (recurring billing)
// Install dependencies: firebase-admin, firebase-functions, node-fetch, cors

const admin = require('firebase-admin');
const functions = require('firebase-functions');
const fetch = require('node-fetch').default;
const cors = require('cors')({ origin: true });
const nodemailer = require('nodemailer');
admin.initializeApp();
const db = admin.firestore();
const { GraphQLClient, gql } = require('graphql-request');
const axios = require('axios');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');

// Temporary hardcoded test credentials (for testing only)
const PAYPLE_CST_ID   = "test";
const PAYPLE_CUST_KEY = "abcd1234567890";
const PAYPLE_REFERER  = "https://democpay.payple.kr";
const API_BASE = 'https://democpay.payple.kr/php';

/**
 * Helper: partner-auth with Payple
 */
async function requestAuthorization(authKey, payerId, reqKey) {
  const body = {
    PCD_CST_ID      : PAYPLE_CST_ID,
    PCD_CUST_KEY    : PAYPLE_CUST_KEY,
    PCD_AUTH_KEY   : authKey,
    PCD_PAY_REQKEY  : reqKey,
    PCD_PAYER_ID    : payerId
  };

  const res = await fetch(`${API_BASE}/PayCardConfirmAct.php?ACT_=PAYM`, {
    method : 'POST',
    headers: {
      'Content-Type'   : 'application/json',
      'Cache-Control'  : 'no-cache',
      'Referer'        : PAYPLE_REFERER
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // HTTP error from Payple
    const text = await res.text().catch(() => '');
    throw new Error(`Payple HTTP ${res.status}: ${text}`);
  }

  return res.json();
}
async function requestBankAuthorization(authKey, payerId, reqKey) {
  const body = {
    PCD_CST_ID      : PAYPLE_CST_ID,
    PCD_CUST_KEY    : PAYPLE_CUST_KEY,
    PCD_AUTH_KEY   : authKey,
    PCD_PAY_REQKEY  : reqKey,
    PCD_PAYER_ID    : payerId
  };

  const res = await fetch(`${API_BASE}/PayConfirmAct.php?ACT_=PAYM`, {
    method : 'POST',
    headers: {
      'Content-Type'   : 'application/json',
      'Cache-Control'  : 'no-cache',
      'Referer'        : PAYPLE_REFERER
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // HTTP error from Payple
    const text = await res.text().catch(() => '');
    throw new Error(`Payple HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

exports.handlePassCallback = functions.https.onRequest(async (req, res) => {
  try {
    // Merge query + body
    const p = { ...req.query, ...req.body };

    // Basic validation
    const userId       = String(p.userId || '').trim();
    const payResult    = String(p.PCD_PAY_RST || '').trim().toLowerCase();
    const authKey      = String(p.PCD_AUTH_KEY || '').trim();
    const payerId      = String(p.PCD_PAYER_ID || '').trim();
    const payReqKey    = String(p.PCD_PAY_REQKEY || '').trim();
    const paymentId    = String(p.paymentId || '').trim();
    const totalPayment = Number(p.PCD_PAY_TOTAL);
    const cardNumber   = String(p.PCD_PAY_CARDNUM);
    const cardName     = String(p.PCD_PAY_CARDNAME);

    if (!userId || !paymentId) {
      return res.status(400).send(`<html><body style="text-align:center;"><h1>❌ Payment Failed</h1><p>Missing user ID or payment ID.</p></body></html>`);
    }

    // Reference to the single pending order for this paymentId
    const pendingOrderQuery = await admin.firestore()
      .collection('pending_orders')
      .where('userId', '==', userId)
      .where('paymentId', '==', paymentId)
      .limit(1)
      .get();
    if (pendingOrderQuery.empty) {
      return res.status(404).send(`<html><body style="text-align:center;"><h1>❌ Payment Failed</h1><p>No pending order found for this payment.</p></body></html>`);
    }
    const pendingOrderDoc = pendingOrderQuery.docs[0];

    // If payment failed, update pending_order and return
    if (payResult !== 'success') {
      const msg = p.PCD_PAY_MSG || 'Payment not successful.';
      await pendingOrderDoc.ref.update({ status: 'failed' });
      return res.status(200).json([p, p]);
    }

    // Validate required params for requestAuthorization
    if (!authKey || !payerId || !payReqKey) {
      await pendingOrderDoc.ref.update({ status: 'failed' });
      return res.status(400).send(`<html><body style="text-align:center;"><h1>❌ Payment Failed</h1><p>Missing authKey, payerId, or payReqKey for authorization.</p></body></html>`);
    }

    // Call Payple auth API
    const auth = await requestAuthorization(authKey, payerId, payReqKey);

    if (!auth.result || String(auth.result).toLowerCase() !== 'success') {
      // Mark pending_order as failed
      await pendingOrderDoc.ref.update({ status: 'failed' });
      return res.status(500).json([p, auth]);
    }

    // Mark the single pending_order as success
    await pendingOrderDoc.ref.update({ status: 'success' });

    // Write to Firestore payments subcollection
    const userRef    = admin.firestore().collection('users').doc(userId);
    const paymentsCol= userRef.collection('payments');
    const paymentRef = paymentsCol.doc(paymentId);  // auto-generated ID

    await paymentRef.set({
      paymentId   : paymentId,
      userId : userId,
      paymentMethod : 'card',
      totalPayment,
      paymentDate : admin.firestore.Timestamp.now(),
    });

    const cardInfo = {};
    if (payerId) cardInfo.payerId = payerId;
    if (cardName) cardInfo.cardName = cardName;
    if (cardNumber) cardInfo.cardNumber = cardNumber;
    if (Object.keys(cardInfo).length > 0) {
      await userRef.set({ card: cardInfo }, { merge: true });
    }

    // === Cash Receipt Issuance Logic (Popbill, direct call, parameter-driven) ===
    const customerName = p.userName || '';
    const email = p.email || '';
    const hp = p.phoneNo || '';
    const itemName = p.productName || p.itemName || '상품';
    const orderNumber = p.orderNumber || paymentId;
    const identityNum = hp.replace(/[^0-9]/g, '').slice(-11); // Use phone for 소득공제용
    const supplyCost = Math.round(totalPayment / 1.1);
    const tax = totalPayment - supplyCost;
    // Sanitize paymentId for Popbill mgtKey: only alphanumeric, hyphen, and underscore, max 24 chars
    let safePaymentId = String(paymentId).replace(/[^a-zA-Z0-9_-]/g, '_');
    let mgtKeyRaw = `${safePaymentId}_${Date.now()}`;
    // Popbill mgtKey: 1~24 chars, so truncate if needed
    let mgtKey = mgtKeyRaw.slice(0, 24);

    let cashReceiptResult = null;
    try {
      cashReceiptResult = await issueCashReceiptDirect({
        mgtKey,
        tradeDT: new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
        identityNum,
        supplyCost: String(supplyCost),
        tax: String(tax),
        totalAmount: String(totalPayment),
        itemName,
        orderNumber,
        customerName,
        email,
        hp
      });
    } catch (e) {
      cashReceiptResult = { success: false, message: e.message };
    }

    // Return success page with cash receipt result
    return res.status(200).send(`
      <html>
        <head><title>Payment Success</title></head>
        <body style="text-align:center;">
          <h1>✅ Payment Successful</h1>
          <p>Thank you for your order. Your payment was successful.</p>
          <h2>현금영수증 발행 결과</h2>
          <p>
            ${cashReceiptResult && cashReceiptResult.success ?
              `✅ 현금영수증이 정상 발행되었습니다.<br>메시지: ${cashReceiptResult.message}` :
              `❌ 현금영수증 발행 실패<br>메시지: ${(cashReceiptResult && cashReceiptResult.message) || '오류'}`
            }
          </p>
        </body>
      </html>
    `);

  } catch (err) {
    console.error('Error in billing callback:', err);
    return res.status(500).send(`
      <html>
        <head><title>Payment Failed</title></head>
        <body style="text-align:center;">
          <h1>❌ Payment Failed</h1>
          <p>Server error occurred. Please contact support.</p>
        </body>
      </html>
    `);
  }
});

exports.handleBankPassCallback = functions.https.onRequest(async (req, res) => {
  try {
    // Merge query + body
    const p = { ...req.query, ...req.body };

    // Basic validation
    const userId       = String(p.userId || '').trim();
    const payResult    = String(p.PCD_PAY_RST || '').trim().toLowerCase();
    const authKey      = String(p.PCD_AUTH_KEY || '').trim();
    const payerId      = String(p.PCD_PAYER_ID || '').trim();
    const payReqKey    = String(p.PCD_PAY_REQKEY || '').trim();
    const paymentId    = String(p.paymentId || '').trim();
    const totalPayment = Number(p.PCD_PAY_TOTAL);
    const bankNumber   = String(p.PCD_PAY_BANKNUM || '').trim();
    const bankName     = String(p.PCD_PAY_BANKNAME || '').trim();

    if (!userId || !paymentId) {
      return res.status(400).send(`<html><body style="text-align:center;"><h1>❌ Payment Failed</h1><p>Missing user ID or payment ID.</p></body></html>`);
    }

    // Reference to the single pending order for this paymentId
    const pendingOrderQuery = await admin.firestore()
      .collection('pending_orders')
      .where('userId', '==', userId)
      .where('paymentId', '==', paymentId)
      .limit(1)
      .get();
    if (pendingOrderQuery.empty) {
      return res.status(404).send(`<html><body style="text-align:center;"><h1>❌ Payment Failed</h1><p>No pending order found for this payment.</p></body></html>`);
    }
    const pendingOrderDoc = pendingOrderQuery.docs[0];

    // If payment failed, update pending_order and return
    if (payResult !== 'success') {
      const msg = p.PCD_PAY_MSG || 'Payment not successful.';
      await pendingOrderDoc.ref.update({ status: 'failed' });
      return res.status(200).json([p, p]);
    }

    // Validate required params for requestBankAuthorization
    if (!authKey || !payerId || !payReqKey) {
      await pendingOrderDoc.ref.update({ status: 'failed' });
      return res.status(400).send(`<html><body style="text-align:center;"><h1>❌ Payment Failed</h1><p>Missing authKey, payerId, or payReqKey for authorization.</p></body></html>`);
    }

    // Call Payple auth API
    const auth = await requestBankAuthorization(authKey, payerId, payReqKey);

    if (!auth.PCD_PAY_RST || String(auth.PCD_PAY_RST).toLowerCase() !== 'success') {
      // Mark pending_order as failed
      await pendingOrderDoc.ref.update({ status: 'failed' });
      return res.status(500).json([p, auth]);
    }

    // Mark the single pending_order as success
    await pendingOrderDoc.ref.update({ status: 'success' });

    // Write to Firestore payments subcollection
    const userRef    = admin.firestore().collection('users').doc(userId);
    const paymentsCol= userRef.collection('payments');
    const paymentRef = paymentsCol.doc(paymentId);

    await paymentRef.set({
      paymentId   : paymentId,
      userId      : userId,
      paymentMethod : 'bank',
      totalPayment,
      paymentDate : admin.firestore.Timestamp.now(),
    });

    // Save bank info if available
    const bankInfo = {};
    if (payerId)   bankInfo.payerId = payerId;
    if (bankName)  bankInfo.bankName = bankName;
    if (bankNumber) bankInfo.bankNumber = bankNumber;
    if (Object.keys(bankInfo).length > 0) {
      await userRef.set({ bank: bankInfo }, { merge: true });
    }

    // === Cash Receipt Issuance Logic (Popbill, direct call) ===
    const customerName = p.userName || '';
    const email = p.email || '';
    const hp = p.phoneNo || '';
    const itemName = p.productName || p.itemName || '상품';
    const orderNumber = p.orderNumber || paymentId;
    const identityNum = hp.replace(/[^0-9]/g, '').slice(-11); // Use phone for 소득공제용
    const supplyCost = Math.round(totalPayment / 1.1);
    const tax = totalPayment - supplyCost;
    // Sanitize paymentId for Popbill mgtKey: only alphanumeric, hyphen, and underscore, max 24 chars
    let safePaymentId = String(paymentId).replace(/[^a-zA-Z0-9_-]/g, '_');
    let mgtKeyRaw = `${safePaymentId}_${Date.now()}`;
    // Popbill mgtKey: 1~24 chars, so truncate if needed
    let mgtKey = mgtKeyRaw.slice(0, 24);

    let cashReceiptResult = null;
    try {
      cashReceiptResult = await issueCashReceiptDirect({
        mgtKey,
        tradeDT: new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
        identityNum,
        supplyCost: String(supplyCost),
        tax: String(tax),
        totalAmount: String(totalPayment),
        itemName,
        orderNumber,
        customerName,
        email,
        hp
      });
    } catch (e) {
      cashReceiptResult = { success: false, message: e.message };
    }

    // Return success page with cash receipt result
    return res.status(200).send(`
      <html>
        <head><title>Payment Success</title></head>
        <body style="text-align:center;">
          <h1>✅ Payment Successful</h1>
          <p>Thank you for your order. Your payment was successful.</p>
          <h2>현금영수증 발행 결과</h2>
          <p>
            ${cashReceiptResult && cashReceiptResult.success ?
              `✅ 현금영수증이 정상 발행되었습니다.<br>메시지: ${cashReceiptResult.message}` :
              `❌ 현금영수증 발행 실패<br>메시지: ${(cashReceiptResult && cashReceiptResult.message) || '오류'}`
            }
          </p>
        </body>
      </html>
    `);

  } catch (err) {
    console.error('Error in billing callback:', err);
    return res.status(500).send(`
      <html>
        <head><title>Payment Failed</title></head>
        <body style="text-align:center;">
          <h1>❌ Payment Failed</h1>
          <p>Server error occurred. Please contact support.</p>
        </body>
      </html>
    `);
  }
});

async function partnerAuth(workType = 'AUTH') {
  const body = {
    cst_id: PAYPLE_CST_ID,
    custKey: PAYPLE_CUST_KEY,
    PCD_PAY_TYPE: 'transfer',  
    PCD_SIMPLE_FLAG:'Y'
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

async function cancelAuth(workType = 'AUTH') {
  const body = {
    cst_id: PAYPLE_CST_ID,
    custKey: PAYPLE_CUST_KEY,
    PCD_PAYCANCEL_FLAG:'Y'
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
 * Payple Partner Authentication (Token Issuance)
 * Issues a partner access token for Payple settlement API usage.
 * POST: { service_id, service_key, code } (see Payple docs)
 * Returns: { accessToken } on success, or error details.
 */
exports.paypleSettlementAuth = functions.https.onRequest(async (req, res) => {
  try {
    // Only allow POST
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    // Parse input
    const { service_id, service_key, code } = req.body;
    if (!service_id || !service_key || !code) {
      return res.status(400).json({ error: 'Missing required fields: service_id, service_key, code' });
    }
    // Call Payple partner auth endpoint
    const response = await fetch('https://demo-api.payple.kr/gpay/oauth/1.0/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Referer': PAYPLE_REFERER
      },
      body: JSON.stringify({
        service_id,
        service_key,
        code
      })
    });
    const json = await response.json();
    if (json.result !== 'T0000') {
      return res.status(400).json(json);
    }
    // Return only the access token
    return res.json({ accessToken: json.access_token });
  } catch (err) {
    console.error('Error in paypleSettlementAuth:', err);
    return res.status(500).json({ error: err.message });
  }
});

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
    return res.status(400).send(`
      <html>
        <head><title>Payment Failed</title></head>
        <body style="text-align:center;">
          <h1>❌ Payment Failed</h1>
          <p>Missing user ID.</p>
        </body>
      </html>
    `);
  }

  // Check payment result
  if (p.PCD_PAY_RST !== 'success') {
    return res.status(200).send(`
      <html>
        <head><title>Payment Failed</title></head>
        <body style="text-align:center;">
          <h1>❌ Payment Failed</h1>
          <p>${p.PCD_PAY_MSG || 'Something went wrong with the payment.'}</p>
        </body>
      </html>
    `);
  }

  try {
    const billingKey = p.PCD_PAYER_ID;
    const orderId= p.PCD_PAY_OID
    const nextBilling = admin.firestore.Timestamp.fromDate(
      new Date(new Date().setMonth(new Date().getMonth() + 1))
    );
    await db.collection('subscriptions').doc(orderId).set({
      orderId,
      userId,
      billingKey,
      status: 'active',
      nextBillingDate: nextBilling,
      lastPaymentDate: admin.firestore.Timestamp.now(),
    }, { merge: true });
    await db.collection('users').doc(userId).set({ isSub: true }, { merge: true });
    return res.status(200).send(`
      <html>
        <head><title>Payment Success</title></head>
        <body style="text-align:center;">
          <h1>✅ Payment Successful</h1>
          <p>Thank you for subscribing. Your plan is now active.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error handling billing callback:', error);
    return res.status(500).send(`
      <html>
        <head><title>Payment Failed</title></head>
        <body style="text-align:center;">
          <h1>❌ Payment Failed</h1>
          <p>Server error occurred. Please contact support.</p>
        </body>
      </html>
    `);
  }
});


/**
 * 3) Trigger First Payment (callable)
 */
// exports.triggerFirstPayment = functions.https.onCall(async (data, context) => {
//   const uid = context.auth?.uid;
//   if (!uid) throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');

//   const docRef = db.collection('subscriptions').doc(uid);
//   const subSnap = await docRef.get();
//   const sub = subSnap.data();
//   if (!sub?.billingKey) throw new functions.https.HttpsError('failed-precondition', 'No billing key');

//   const authData = await partnerAuth();
//   if (!authData.result || authData.result.toLowerCase() !== 'success') {
//     throw new functions.https.HttpsError('internal', 'Auth failed', authData);
//   }

//   const payRes = await fetch(`${API_BASE}/SimplePayCardAct.php?ACT_=PAYM`, {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json', 'Referer': PAYPLE_REFERER },
//     body: JSON.stringify({
//       PCD_CST_ID: authData.cst_id,
//       PCD_CUST_KEY: authData.custKey,
//       PCD_AUTH_KEY: authData.AuthKey,
//       PCD_PAY_TYPE: 'card',
//       PCD_PAYER_ID: sub.billingKey,
//       PCD_PAY_GOODS: 'Subscription (1 month)',
//       PCD_PAY_TOTAL: String(sub.planPrice),
//       PCD_SIMPLE_FLAG: 'Y'
//     })
//   });
//   const payJson = await payRes.json();
//   if (!payJson.result || payJson.result.toLowerCase() !== 'success') {
//     throw new functions.https.HttpsError('internal', 'Payment failed', payJson);
//   }

//   const next = admin.firestore.Timestamp.fromDate(
//     new Date(now.toDate().setMonth(now.toDate().getMonth() + 1))
//   );
//   await docRef.update({ nextBillingDate: next });
//   return { status: 'charged', nextBillingDate: next };
// });

/**
 * 4) Renewal Endpoint (HTTP)
 */
exports.renewMonthlySubscriptions = functions.https.onRequest(async (req, res) => {
  const now = admin.firestore.Timestamp.now();
  // Fetch subscriptions that are either active or canceled and due for action
  const snap = await db.collection('subscriptions')
    .where('nextBillingDate', '<=', now)
    .where('status', 'in', ['active', 'canceled'])
    .get();

  if (snap.empty) {
    return res.json({ processed: 0, details: [], message: 'No subscriptions to process.' });
  }

  const FIXED_PRICE = 3000;
  const results = [];
  for (const doc of snap.docs) {
    try {
      const sub = doc.data();
      const { billingKey, userId, status, nextBillingDate } = sub;
      if (!userId) {
        results.push({ id: doc.id, status: 'skipped', reason: 'Missing userId' });
        continue;
      }
      const userRef = db.collection('users').doc(userId);
      // Handle canceled subscriptions: downgrade on the day before nextBillingDate
      if (status === 'canceled') {
        // Check if today is the day before nextBillingDate
        const nextBilling = nextBillingDate?.toDate?.() || new Date();
        const nowDate = new Date(now.toDateString ? now.toDateString() : now.toDate());
        const dayBefore = new Date(nextBilling);
        dayBefore.setDate(dayBefore.getDate() - 1);
        if (
          nowDate.getFullYear() === dayBefore.getFullYear() &&
          nowDate.getMonth() === dayBefore.getMonth() &&
          nowDate.getDate() === dayBefore.getDate()
        ) {
          // Downgrade user and expire subscription
          await userRef.set({ isSub: false }, { merge: true });
          await doc.ref.update({ status: 'expired', nextBillingDate: null });
          results.push({ id: doc.id, status: 'expired', reason: 'Canceled period ended, user downgraded.' });
        } else {
          // Still in premium period
          results.push({ id: doc.id, status: 'canceled', reason: 'Still in premium period.' });
        }
        continue;
      }
      // Handle active subscriptions: process payment
      if (!billingKey) {
        results.push({ id: doc.id, status: 'skipped', reason: 'Missing billingKey' });
        continue;
      }
      // Always use 'transfer' for bank payments
      const payType = 'transfer';
      const authData = await partnerAuth();
      if (!authData.result || authData.result.toLowerCase() !== 'success') {
        results.push({ id: doc.id, status: 'skipped', reason: 'Auth failed' });
        continue;
      }
      const payRes = await fetch(`${API_BASE}/SimplePayAct.php?ACT_=PAYM`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Referer': PAYPLE_REFERER
        },
        body: JSON.stringify({
          PCD_CST_ID: authData.cst_id,
          PCD_CUST_KEY: authData.custKey,
          PCD_AUTH_KEY: authData.AuthKey,
          PCD_PAY_TYPE: payType,
          PCD_PAYER_ID: billingKey,
          PCD_PAY_GOODS: 'Subscription (1 month)',
          PCD_PAY_TOTAL: String(FIXED_PRICE),
          PCD_SIMPLE_FLAG: 'Y'
        })
      });
      const payJson = await payRes.json();
      // Generate a paymentId for this attempt
      const paymentId = `renewal_${doc.id}_${now.toMillis()}`;
      // Store payment attempt in payments subcollection
      await doc.ref.collection('payments').add({
        paymentId,
        date: now,
        amount: FIXED_PRICE,
        result: payJson.PCD_PAY_RST || 'failed',
        payMsg: payJson.PCD_PAY_MSG || '',
      });
      if (payJson.PCD_PAY_RST && payJson.PCD_PAY_RST.toLowerCase() === 'success') {
        const next = admin.firestore.Timestamp.fromDate(
          new Date(now.toDate().setMonth(now.toDate().getMonth() + 1))
        );
        await doc.ref.update({
          status: 'active',
          nextBillingDate: next,
          lastPaymentDate: now,
        });
        await userRef.set({ isSub: true }, { merge: true });
        results.push({ id: doc.id, status: 'renewed' });
      } else {
        await doc.ref.update({
          status: 'payment_failed',
          nextBillingDate: null,
          lastPaymentDate: now,
        });
        await userRef.set({ isSub: false }, { merge: true });
        results.push({ id: doc.id, status: 'failed', reason: payJson.PCD_PAY_MSG || 'Payment failed' });
      }
    } catch (err) {
      console.error(`Error processing subscription ${doc.id}:`, err);
      await doc.ref.update({
        status: 'payment_failed',
        nextBillingDate: null,
        lastPaymentDate: admin.firestore.Timestamp.now(),
      });
      results.push({ id: doc.id, status: 'error', reason: err.message });
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


// Configure your email service
const API_KEY = "5555555555";

// Configure email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'jkheko@gmail.com',
    pass: 'M123456M'
  }
});

exports.sendCredentialEmail = functions.https.onRequest((req, res) => {
  // Enable CORS for browser requests
  return cors(req, res, async () => {
    try {
      // Check method
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }
      
      // Check API key
      const apiKey = req.headers.authorization;
      if (!apiKey || apiKey !== `Bearer ${API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      // Get data from request body
      const { email, password, name } = req.body;
      
      if (!email || !password || !name) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Send email
      const mailOptions = {
        from: 'jkheko@example.com',
        to: email,
        subject: 'Your Account Details',
        text: `Hello ${name},\n\nYour account has been created.\n\nEmail: ${email}\nPassword: ${password}\n\nPlease change your password after the first login.\n\nRegards,\nYour Team`,
        html: `<p>Hello ${name},</p><p>Your account has been created.</p><p><b>Email:</b> ${email}<br><b>Password:</b> ${password}</p><p>Please change your password after the first login.</p><p>Regards,<br>Your Team</p>`
      };
      
      const info = await transporter.sendMail(mailOptions);
      console.log('Email sent:', info.messageId);
      
      // Return success
      return res.status(200).json({ success: true, messageId: info.messageId });
    } catch (error) {
      console.error('Error:', error);
      return res.status(500).json({ error: error.message });
    }
  });
});



// const GRAPHQL_ENDPOINT = 'https://api.deliverytracker.com/graphql';
// const TRACKING_API_KEY = '6fvqe192p5v5ik6p5aev1ntud4:1eh63r90t9mms8be76r2npve71fcoeqi70e5pud3ve2vfvtdietd';
// const client = new GraphQLClient(GRAPHQL_ENDPOINT, {
//   headers: { Authorization: `TRACKQL-API-KEY ${TRACKING_API_KEY}` }
// });

// … your TRACK_Q and REGISTER_WEBHOOK_Q definitions …

// === 1) Process Tracking Queue via HTTPS ===
// exports.processTrackingQueue = functions.https.onRequest(async (req, res) => {
//   // Optional: you can restrict to POST and check a shared secret header
//   if (req.method !== 'POST') {
//     return res.status(405).send('Method Not Allowed');
//   }

//   try {
//     const queueRef = admin.firestore().collection('trackingQueue');
//     const snapshot = await queueRef
//       .where('status', '==', 'pending')
//       .orderBy('timestamp')
//       .limit(50)
//       .get();

//     if (snapshot.empty) {
//       console.log('No pending tracking updates to process');
//       return res.status(200).send('No work');
//     }

//     const batch = admin.firestore().batch();
//     const promises = [];

//     snapshot.forEach(doc => {
//       const data = doc.data();
//       batch.update(doc.ref, { status: 'processing' });
//       promises.push(processTrackingUpdate(data, doc.ref, batch));
//     });

//     await batch.commit();
//     await Promise.all(promises);

//     return res.status(200).send('Processed');
//   } catch (err) {
//     console.error('Error in processTrackingQueue:', err);
//     return res.status(500).send('Internal Error');
//   }
// });

// // === 2) Keep Webhooks Alive via HTTPS ===
// exports.keepWebhooksAlive = functions.https.onRequest(async (req, res) => {
//   // Optional: restrict to POST & check auth
//   if (req.method !== 'POST') {
//     return res.status(405).send('Method Not Allowed');
//   }

//   try {
//     const activeOrdersSnapshot = await admin
//       .firestore()
//       .collection('orders')
//       .where('trackingActive', '==', true)
//       .get();

//     if (activeOrdersSnapshot.empty) {
//       console.log('No active orders to keep tracking');
//       return res.status(200).send('No active orders');
//     }

//     const webhookUrl = `https://${process.env.FUNCTION_REGION}-${process.env.GCP_PROJECT}.cloudfunctions.net/trackingWebhook`;
//     const expirationTime = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

//     const promises = activeOrdersSnapshot.docs.map(orderDoc => {
//       const { carrierId, trackingNumber } = orderDoc.data();
//       return client.request(REGISTER_WEBHOOK_Q, {
//         input: { carrierId, trackingNumber, callbackUrl: webhookUrl, expirationTime }
//       });
//     });

//     await Promise.all(promises);
//     console.log(`Extended tracking for ${promises.length} orders`);
//     return res.status(200).send('Webhooks extended');
//   } catch (err) {
//     console.error('Error in keepWebhooksAlive:', err);
//     return res.status(500).send('Internal Error');
//   }
// });


exports.trackingWebhook = functions.https.onRequest(async (req, res) => {
  // Verify this is a POST request
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  
  // Get tracking details from request body
  const { carrierId, trackingNumber } = req.body;
  
  if (!carrierId || !trackingNumber) {
    res.status(400).send('Bad Request: Missing required fields');
    return;
  }
  
  try {
    // 1. Quickly send a 202 Accepted response as recommended
    res.status(202).send('Accepted');
    
    // 2. Call the Delivery Tracker API to get latest tracking info
    const response = await axios.post('https://apis.tracker.delivery/graphql', {
      query: `query Track($carrierId: ID!, $trackingNumber: String!) {
                track(carrierId: $carrierId, trackingNumber: $trackingNumber) {
                  status {
                    code
                    text
                  }
                  events {
                    time
                    status {
                      code
                      text
                    }
                    location {
                      name
                    }
                    description
                  }
                }
              }`,
      variables: {
        carrierId,
        trackingNumber
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `6fvqe192p5v5ik6p5aev1ntud4:1eh63r90t9mms8be76r2npve71fcoeqi70e5pud3ve2vfvtdietd`
      }
    });
    
    const trackingData = response.data.data.track;
    
    // 3. Find tracking documents in Firestore
    const trackingsQuery = await admin.firestore()
      .collection('orders')
      .where('carrierId', '==', carrierId)
      .where('trackingNumber', '==', trackingNumber)
      .get();
    
    if (trackingsQuery.empty) {
      console.warn(`No tracking found for ${carrierId}:${trackingNumber}`);
      return;
    }
    
    // 4. Update all matching tracking documents
    const batch = admin.firestore().batch();
    trackingsQuery.forEach(doc => {
      batch.update(doc.ref, {
        orderStatus: trackingData.status.code,
        trackingEvents: trackingData.events,
      });
    });
    
    await batch.commit();
    console.log(`Updated tracking info for ${carrierId}:${trackingNumber}`);
    
  } catch (error) {
    console.error('Error processing tracking webhook:', error);
  }
});





exports.notifyPostLike = onDocumentUpdated('posts/{postId}', async (event) => {
  try {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after || after.likes <= before.likes) return null;

    const beforeLikedBy = before.likedBy || [];
    const afterLikedBy = after.likedBy || [];
    const newLikers = afterLikedBy.filter(uid => !beforeLikedBy.includes(uid));
    if (newLikers.length === 0) return null;

    const postOwnerId = after.ownerId || after.userId;
    if (!postOwnerId) return null;

    // Get latest liker info
    const lastLikerId = newLikers[newLikers.length - 1];
    if (lastLikerId === postOwnerId) return null;

    let lastLikerName = "누군가";
    try {
      const userDoc = await admin.auth().getUser(lastLikerId);
      lastLikerName = userDoc.displayName || "누군가";
    } catch (e) {
      // fallback to default
    }

    // Throttle: check if user has more than 10 notifications in last 5 minutes
    const notificationsRef = admin
      .firestore()
      .collection('users')
      .doc(postOwnerId)
      .collection('notifications');

    const now = admin.firestore.Timestamp.now();
    const fiveMinAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 5 * 60 * 1000);
    const recentNotifsSnap = await notificationsRef
      .where('timestamp', '>=', fiveMinAgo)
      .get();

    if (recentNotifsSnap.size > 10) {
      const fifteenMinAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 15 * 60 * 1000);
      const lastNotifSnap = await notificationsRef
        .where('timestamp', '>=', fifteenMinAgo)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (!lastNotifSnap.empty) {
        return null;
      }
    }

    // Build notification message
    let title = "새로운 좋아요";
    let body = "";
    if (after.likes > 10) {
      body = `${lastLikerName}님 외 ${after.likes - 1}명이 회원님 게시글을 좋아합니다.`;
    } else {
      body = `${lastLikerName}님이 회원님 게시글을 좋아합니다.`;
    }

    const notification = {
      title,
      body,
      type: "like",
      postId: event.params.postId,
      isRead: false,
      timestamp: now,
      fromUserId: lastLikerId,
    };

    await notificationsRef.add(notification);
    return null;
  } catch (err) {
    console.error('Error in notifyPostLike:', err);
    return null;
  }
});

exports.notifyCommentLike = onDocumentUpdated('posts/{postId}/comments/{commentId}', async (event) => {
  try {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return null;

    // Only proceed if likes counter increased
    if (typeof after.likes !== "number" || typeof before.likes !== "number" || after.likes <= before.likes) return null;

    // Use the correct field name: likedBy (camelCase)
    const beforeLikedBy = Array.isArray(before.likedBy) ? before.likedBy : [];
    const afterLikedBy = Array.isArray(after.likedBy) ? after.likedBy : [];
    const newLikers = afterLikedBy.filter(uid => !beforeLikedBy.includes(uid));
    if (newLikers.length === 0) return null;

    const commentOwnerId = after.userId;
    if (!commentOwnerId) return null;

    // Get latest liker info
    const lastLikerId = newLikers[newLikers.length - 1];
    if (lastLikerId === commentOwnerId) return null;

    let lastLikerName = "누군가";
    try {
      const userDoc = await admin.auth().getUser(lastLikerId);
      lastLikerName = userDoc.displayName || lastLikerName;
    } catch (e) {}

    // Throttle logic
    const notificationsRef = admin
      .firestore()
      .collection('users')
      .doc(commentOwnerId)
      .collection('notifications');

    const now = admin.firestore.Timestamp.now();
    const fiveMinAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 5 * 60 * 1000);
    const recentNotifsSnap = await notificationsRef
      .where('timestamp', '>=', fiveMinAgo)
      .get();

    if (recentNotifsSnap.size > 10) {
      const fifteenMinAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 15 * 60 * 1000);
      const lastNotifSnap = await notificationsRef
        .where('timestamp', '>=', fifteenMinAgo)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (!lastNotifSnap.empty) {
        return null;
      }
    }

    // Build notification message with comment text
    let title = "댓글 좋아요";
    let body = "";
    if (after.likes > 10) {
      body = `${lastLikerName}님 외 ${after.likes - 1}명이 회원님의 댓글을 좋아합니다.\n${after.text || ""}`;
    } else {
      body = `${lastLikerName}님이 회원님의 댓글을 좋아합니다.\n${after.text || ""}`;
    }

    const notification = {
      title,
      body,
      type: "comment_like",
      postId: event.params.postId,
      commentId: event.params.commentId,
      commentText: after.text || "",
      isRead: false,
      timestamp: now,
      fromUserId: lastLikerId,
    };

    await notificationsRef.add(notification);
    return null;
  } catch (err) {
    console.error('Error in notifyCommentLike:', err);
    return null;
  }
});

exports.notifyPostComment = onDocumentCreated('posts/{postId}/comments/{commentId}', async (event) => {
  try {
    const snap = event.data;
    if (!snap) return null;
    const comment = snap.data();
    const postId = event.params.postId;
    const commentOwnerId = comment.userId;
    const commentText = comment.text || "";

    // Get post owner
    const postSnap = await admin.firestore().collection('posts').doc(postId).get();
    if (!postSnap.exists) return null;
    const postOwnerId = postSnap.data().ownerId || postSnap.data().userId;
    if (!postOwnerId || postOwnerId === commentOwnerId) return null; // Don't notify self

    // Get commenter name
    let commenterName = "누군가";
    try {
      const userDoc = await admin.auth().getUser(commentOwnerId);
      commenterName = userDoc.displayName || commenterName;
    } catch (e) {
      // fallback to "누군가"
    }

    // Throttle: check if user has more than 10 notifications in last 5 minutes
    const notificationsRef = admin
      .firestore()
      .collection('users')
      .doc(postOwnerId)
      .collection('notifications');

    const now = admin.firestore.Timestamp.now();
    const fiveMinAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 5 * 60 * 1000);
    const recentNotifsSnap = await notificationsRef
      .where('timestamp', '>=', fiveMinAgo)
      .get();

    if (recentNotifsSnap.size > 10) {
      const fifteenMinAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 15 * 60 * 1000);
      const lastNotifSnap = await notificationsRef
        .where('timestamp', '>=', fifteenMinAgo)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (!lastNotifSnap.empty) {
        return null;
      }
    }

    // Build notification message with comment text
    const title = "새 댓글";
    const body = `${commenterName}님이 회원님의 게시글에 댓글을 남겼습니다.\n${commentText}`;

    const notification = {
      title,
      body,
      type: "comment",
      postId: postId,
      commentId: event.params.commentId,
      commentText: commentText,
      isRead: false,
      timestamp: now,
      fromUserId: commentOwnerId,
    };

    await notificationsRef.add(notification);
    return null;
  } catch (err) {
    console.error('Error in notifyPostComment:', err);
    return null;
  }
});

/**
 * 6) Refund Payment (callable)
 * 
 * 
 * Client must pass: orderId (product orderId), refundTotal (amount to refund for this product)
 * All other sensitive/payment info is fetched from Firestore.
 */
exports.requestRefund = functions.https.onCall(async (data, context) => {
  // Support both direct SDK and HTTP (Postman) calls
  const payload = data && data.uid ? data : (data && data.data ? data.data : {});
  let uid = context.auth?.uid;
  if (!uid) {
    uid = payload.uid;
    if (!uid) throw new functions.https.HttpsError('invalid-argument', 'Missing uid (provide in data for unauthenticated test)');
  }

  const { orderId, refundTotal } = payload;
  if (!orderId || !refundTotal) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing orderId or refundTotal');
  }

  // 1. Fetch the order document
  const orderSnap = await db.collection('orders').doc(orderId).get();
  if (!orderSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Order not found');
  }
  const order = orderSnap.data();
  if (order.userId !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'You do not own this order');
  }

  // 2. Get paymentId from order
  const paymentId = order.paymentId;
  if (!paymentId) {
    throw new functions.https.HttpsError('failed-precondition', 'Order missing paymentId');
  }

  // 3. Get payment date (required by Payple)
  let payDate = null;
  if (order.paymentDate && order.paymentDate.toDate) {
    payDate = order.paymentDate.toDate().toISOString().slice(0,10).replace(/-/g, '');
  } else if (order.orderDate) {
    // fallback: try orderDate string (ISO format)
    payDate = order.orderDate.replace(/-/g, '').slice(0,8);
  }
  if (!payDate) {
    throw new functions.https.HttpsError('failed-precondition', 'Missing payment date');
  }

  // 4. Get Payple refund auth
  const authData = await cancelAuth();
  if (!authData.result || authData.result.toLowerCase() !== 'success') {
    throw new functions.https.HttpsError('internal', 'Refund auth failed', authData);
  }

  // 5. Build refund request body
  const refundBody = {
    PCD_CST_ID: authData.cst_id,
    PCD_CUST_KEY: authData.custKey,
    PCD_AUTH_KEY: authData.AuthKey,
    PCD_REFUND_KEY: 'a41ce010ede9fcbfb3be86b24858806596a9db68b79d138b147c3e563e1829a0',
    PCD_PAYCANCEL_FLAG: 'Y',
    PCD_PAY_OID: paymentId,
    PCD_PAY_DATE: payDate,
    PCD_REFUND_TOTAL: String(refundTotal)
  };

  // 6. Call Payple refund endpoint
  const refundRes = await fetch('https://democpay.payple.kr/php/account/api/cPayCAct.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Referer': PAYPLE_REFERER
    },
    body: JSON.stringify(refundBody)
  });
  const refundJson = await refundRes.json();
  const isSuccess = (refundJson.result && refundJson.result.toLowerCase() === 'success') ||
                    (refundJson.PCD_PAY_RST && refundJson.PCD_PAY_RST.toLowerCase() === 'success');
  if (!isSuccess) {
    throw new functions.https.HttpsError('internal', 'Refund failed', refundJson);
  }

  // 7. Add back to product stock and delete the order
  try {
    const productId = order.productId;
    const quantityOrdered = order.quantity;
    if (productId && quantityOrdered) {
      const productRef = db.collection('products').doc(productId);
      await productRef.update({
        stock: admin.firestore.FieldValue.increment(quantityOrdered)
      });
    }
    await db.collection('orders').doc(orderId).delete();
  } catch (e) {
    console.error('Error updating stock or deleting order:', e);
  }

  // 8. Log cancel attempt in Firestore (for audit) as a top-level collection
  await db.collection('canceled_orders').add({
    uid,
    orderId,
    paymentId,
    refundTotal,
    payDate,
    requestedAt: admin.firestore.Timestamp.now()
  });

  return { status: 'refunded', refundResult: refundJson };
});

/**
 * Payple Settlement: Full Process (Token → Account Verify → Transfer)
 * POST { bankCode, accountNo, amount, summary, accountName? }
 * Returns: { token, verify, transfer }
 */

async function settlementAuth(workType = 'AUTH') {
  const body = {
    cst_id: PAYPLE_CST_ID,
    custKey: PAYPLE_CUST_KEY,
    code : 'as12345678'
  };
  if (workType === 'PUSERDEL') body.PCD_PAY_WORK = 'PUSERDEL';

  const res = await fetch(`https://demohub.payple.kr/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  // Expect result === 'T0000' for success
  if (json.result !== 'T0000' || !json.access_token) {
    throw new Error(`Payple auth failed: ${json.message || 'No access_token'}`);
  }
  return json;
}

async function accountVerification(token , sub_id , bank_code_std , account_num , account_holder_info_type , account_holder_info ) {
  const body = {
    cst_id: PAYPLE_CST_ID,
    custKey: PAYPLE_CUST_KEY,
    sub_id : sub_id,
    bank_code_std : bank_code_std,
    account_num : account_num,
    account_holder_info_type : account_holder_info_type,
    account_holder_info : account_holder_info,
  };
 

  const res = await fetch(`https://demohub.payple.kr/inquiry/real_name`, {
    method: 'POST',
    headers: {
     'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });
  return res.json();
}




exports.paypleSettlement = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      // Accept all required params for verification and transfer
      const {
        sub_id,
        bank_code_std,
        account_num,
        account_holder_info_type,
        account_holder_info,
        amount,
        summary
      } = req.body;
      if (!sub_id || !bank_code_std || !account_num || !account_holder_info_type || !account_holder_info || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      // 1. Get partner access token using settlementAuth
      let tokenJson;
      try {
        tokenJson = await settlementAuth();
      } catch (err) {
        return res.status(400).json({ step: 'token', error: 'Token issuance failed', details: err.message });
      }
      const token = tokenJson.access_token;
       const body = {
    cst_id: PAYPLE_CST_ID,
    custKey: PAYPLE_CUST_KEY,
    sub_id : sub_id,
    bank_code_std : bank_code_std,
    account_num : account_num,
    account_holder_info_type : account_holder_info_type,
    account_holder_info : account_holder_info,
  };
      // 2. Account Verification (new API)
      const verifyRes = await fetch(`https://demohub.payple.kr/inquiry/real_name`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`

  },
  body: JSON.stringify(body)
});
const verifyJson = await verifyRes.json();

      if (verifyJson.result !== 'A0000') {
        return res.status(400).json({ step: 'verify', error: 'Account verification failed', details: verifyJson , token : `Bearer ${token}`});
      }
      // 3. Transfer Request to billing key (new API)
      const distinct_key = Date.now().toString(); // or use a UUID if you prefer
      const transferBody = {
        cst_id: PAYPLE_CST_ID,
        custKey: PAYPLE_CUST_KEY,
        sub_id: sub_id,
        distinct_key: distinct_key,
        billing_tran_id: verifyJson.billing_tran_id,
        tran_amt: String(amount),
        print_content: summary || '정산이체'
      };
      const transferRes = await fetch('https://demohub.payple.kr/transfer/request', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify(transferBody)
      });
      const transferJson = await transferRes.json();
      // Payple transfer success result is 'A0000' (not 'T0000')
      if (transferJson.result !== 'A0000') {
        return res.status(400).json({ step: 'transfer', error: 'Transfer failed', details: transferJson });
      }
      // 4. Transfer Execution (execute the pending transfer)
      const executeBody = {
        cst_id: PAYPLE_CST_ID,
        custKey: PAYPLE_CUST_KEY,
        group_key: transferJson.group_key,
        billing_tran_id: 'ALL', // or transferJson.billing_tran_id for specific
        execute_type: 'NOW',
        webhook_url: 'http://pay.pang2chocolate.com/api/webhook'
      };
      const executeRes = await fetch('https://demohub.payple.kr/transfer/execute', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify(executeBody)
      });
      const executeJson = await executeRes.json();
      // Handle Payple transfer execution result
      if (executeJson.result !== 'A0000') {
        // Execution failed
        return res.status(400).json({ step: 'execute', error: 'Transfer execution failed', details: executeJson });
      }
      // Optionally, extract and surface important fields in the response
      const executionResult = {
        result: executeJson.result,
        message: executeJson.message,
        cst_id: executeJson.cst_id,
        group_key: executeJson.group_key,
        billing_tran_id: executeJson.billing_tran_id,
        tot_tran_amt: executeJson.tot_tran_amt,
        remain_amt: executeJson.remain_amt,
        execute_type: executeJson.execute_type,
        api_tran_dtm: executeJson.api_tran_dtm
      };
      // Success: return all results including execution (with parsed executionResult)
      res.json({ token: tokenJson, verify: verifyJson, transfer: transferJson, execute: executionResult });
    } catch (e) {
      console.error('Error in paypleSettlement:', e);
      res.status(500).json({ error: e.message });
    }
  });
});

/**
 * Payple Transfer Execution Webhook Receiver
 * Receives POST requests from Payple after transfer execution.
 * Stores the result in Firestore for audit/history.
 */
exports.paypleTransferWebhook = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Payple sends JSON body
    const data = req.body;

    // Log for debugging
    console.log('Payple transfer webhook received:', data);

    // Optionally, validate required fields
    if (!data || !data.result || !data.api_tran_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store in Firestore for audit/history (collection: payple_transfer_results)
    await admin.firestore().collection('payple_transfer_results').doc(data.api_tran_id).set({
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...data
    });

    // Respond to Payple
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error in paypleTransferWebhook:', err);
    res.status(500).json({ error: err.message });
  }
});




const cashbillService = require('./popbillConfig');


exports.issueCashReceipt = functions.https.onRequest(async (req, res) => {
  const {
    mgtKey,
    tradeDT,
    identityNum,
    supplyCost,
    tax,
    totalAmount,
    itemName,
    orderNumber,
    customerName,
    email,
    hp
  } = req.body;

  const testCorpNum = '4311802323';         // ✅ 사업자번호 (10 digits, no dashes)
  const userID = 'pang2chocolate';          // ✅ Your Popbill User ID
  const stateMemo = '발행메모';              // Optional memo

  const cashbill = {
    mgtKey: mgtKey,
    tradeDT: tradeDT || new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
    tradeType: '승인거래',
    taxationType: '과세',
    tradeUsage: '소득공제용',
    tradeOpt: '일반',
    supplyCost: supplyCost,
    tax: tax,
    serviceFee: '0',
    totalAmount: totalAmount,
    franchiseCorpNum: testCorpNum,
    franchiseCorpName: '가맹점 상호',
    franchiseCEOName: '가맹점 대표자 성명',
    franchiseAddr: '가맹점 주소',
    franchiseTEL: '01012341234',
    identityNum: identityNum,
    itemName: itemName,
    orderNumber: orderNumber,
    customerName: customerName,
    email: email,
    hp: hp,
    smssendYN: false
  };

  try {
    const result = await new Promise((resolve, reject) => {
      cashbillService.registIssue(testCorpNum, cashbill, stateMemo, resolve, reject);
    });

    res.status(200).json({
      success: true,
      code: result.code,
      message: result.message
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      code: error.code,
      message: error.message
    });
  }
});



exports.getCashReceiptPrintURL = functions.https.onRequest(async (req, res) => {
  const { mgtKey } = req.body;

  const corpNum = '4311802323';           // Your 사업자번호
  const userID = 'pang2chocolate';        // Your Popbill user ID

  try {
    const url = await new Promise((resolve, reject) => {
      cashbillService.getPrintURL(corpNum, mgtKey, userID, resolve, reject);
    });

    res.status(200).json({
      success: true,
      url: url
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      code: error.code,
      message: error.message
    });
  }
});

const taxinvoiceService = require('./popbillTaxService');


exports.issueTaxInvoice = functions.https.onRequest(async (req, res) => {
  const corpNum = '4311802323';       // Your 사업자번호 (Popbill test)
  const userID = 'pang2chocolate';    // Popbill test ID

  const {
    mgtKey,
    supplyCostTotal,
    taxTotal,
    totalAmount,
    invoiceeCorpNum,
    invoiceeCorpName,
    invoiceeCEOName,
    invoiceeEmail1,
    detailList = [],
  } = req.body;

  const taxInvoice = {
    writeDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''), // yyyyMMdd
    chargeDirection: '정과금',
    issueType: '정발행',
    purposeType: '영수',
    taxType: '과세',
    invoicerCorpNum: corpNum,
    invoicerMgtKey: mgtKey,
    invoicerCorpName: 'Your Corp Name',
    invoicerCEOName: 'CEO Name',
    invoicerAddr: 'Business Address',
    invoicerBizClass: '업종',
    invoicerBizType: '업태',
    invoicerContactName: '담당자',
    invoicerTEL: '010-1234-5678',
    invoicerEmail: 'your@email.com',
    invoicerSMSSendYN: false,

    invoiceeType: '사업자',
    invoiceeCorpNum: invoiceeCorpNum,
    invoiceeCorpName: invoiceeCorpName,
    invoiceeCEOName: invoiceeCEOName,
    invoiceeAddr: '받는이 주소',
    invoiceeBizClass: '받는이 업종',
    invoiceeBizType: '받는이 업태',
    invoiceeContactName1: '받는이 담당자',
    invoiceeTEL1: '010-0000-0000',
    invoiceeHP1: '010-0000-0000',
    invoiceeEmail1: invoiceeEmail1,
    invoiceeSMSSendYN: false,

    supplyCostTotal: supplyCostTotal,
    taxTotal: taxTotal,
    totalAmount: totalAmount,
    remark1: '비고',

    detailList: detailList,

    addContactList: [
      {
        serialNum: 1,
        contactName: '추가담당자',
        email: invoiceeEmail1,
      },
    ],
  };

  try {
    const result = await new Promise((resolve, reject) => {
      taxinvoiceService.registIssue(corpNum, taxInvoice, resolve, reject);
    });

    res.status(200).json({
      success: true,
      code: result.code,
      message: result.message,
      ntsConfirmNum: result.ntsConfirmNum,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      code: err.code,
      message: err.message,
    });
  }
});






/**
 * Direct Popbill Cash Receipt Issuance (reusable async function)
 * Accepts the same params as the HTTP endpoint, returns result object.
 */
async function issueCashReceiptDirect({
  mgtKey,
  tradeDT,
  identityNum,
  supplyCost,
  tax,
  totalAmount,
  itemName,
  orderNumber,
  customerName,
  email,
  hp
}) {
  const cashbillService = require('./popbillConfig');
  const testCorpNum = '4311802323';         // 사업자번호 (10 digits, no dashes)
  const stateMemo = '발행메모';              // Optional memo

  const cashbill = {
    mgtKey: mgtKey,
    tradeDT: tradeDT || new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
    tradeType: '승인거래',
    taxationType: '과세',
    tradeUsage: '소득공제용',
    tradeOpt: '일반',
    supplyCost: supplyCost,
    tax: tax,
    serviceFee: '0',
    totalAmount: totalAmount,
    franchiseCorpNum: testCorpNum,
    franchiseCorpName: '가맹점 상호',
    franchiseCEOName: '가맹점 대표자 성명',
    franchiseAddr: '가맹점 주소',
    franchiseTEL: '01012341234',
    identityNum: identityNum,
    itemName: itemName,
    orderNumber: orderNumber,
    customerName: customerName,
    email: email,
    hp: hp,
    smssendYN: false
  };

  try {
    const result = await new Promise((resolve, reject) => {
      cashbillService.registIssue(testCorpNum, cashbill, stateMemo, resolve, reject);
    });
    return {
      success: true,
      code: result.code,
      message: result.message
    };
  } catch (error) {
    return {
      success: false,
      code: error.code,
      message: error.message
    };
  }
}