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
    const cardNumber= String(p.PCD_PAY_CARDNUM);
    const cardName= String(p.PCD_PAY_CARDNAME);

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
      return res.status(200).json([p,p]);
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
      return res.status(500).json([p,auth]);
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

    // Return success page
    return res.status(200).send(`
      <html>
        <head><title>Payment Success</title></head>
        <body style="text-align:center;">
          <h1>✅ Payment Successful</h1>
          <p>Thank you for your order. Your payment was successful.</p>
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

    // Return success page
    return res.status(200).send(`
      <html>
        <head><title>Payment Success</title></head>
        <body style="text-align:center;">
          <h1>✅ Payment Successful</h1>
          <p>Thank you for your order. Your payment was successful.</p>
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


// exports.authenticatePayple = functions.https.onRequest(async (req, res) => {
//   try {
//     const resp = await fetch("https://demo-api.payple.kr/gpay/oauth/1.0/token", {
//       method: "POST",
//       headers: {
//         "Content-Type":  "application/json",
//         "Cache-Control": "no-cache",
//         "Referer":       "https://<YOUR_PROJECT>.web.app"
//       },
//       body: JSON.stringify({
//         service_id:  "demo",
//         service_key: "abcd1234567890",
//         code:        "as12345678"
//       })
//     });
//     const json = await resp.json();
//     if (json.result !== "T0000") {
//       return res.status(400).json(json);
//     }
//     // Send back only the access_token
//     res.json({ accessToken: json.access_token });
//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Internal Server Error");
//   }
// });

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
//     new Date(new Date().setMonth(new Date().getMonth() + 1))
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