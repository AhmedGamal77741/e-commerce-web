// functions/index.js
const functions = require("firebase-functions");
const fetch     = require("node-fetch");

//  OAuth token fetcher
exports.authenticatePayple = functions.https.onRequest(async (req, res) => {
  try {
    const resp = await fetch("https://demo-api.payple.kr/gpay/oauth/1.0/token", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "no-cache",
        "Referer":       "https://<YOUR_PROJECT>.web.app"
      },
      body: JSON.stringify({
        service_id:  "demo",
        service_key: "abcd1234567890",
        code:        "as12345678"
      })
    });
    const json = await resp.json();
    if (json.result !== "T0000") {
      return res.status(400).json(json);
    }
    // Send back only the access_token
    res.json({ accessToken: json.access_token });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

//  Payment result callback
exports.paymentCallback = functions.https.onRequest((req, res) => {
  // Payple will POST all payment fields here:
  const data = req.body;
  console.log("Payple callback payload:", data);

  // Return a small HTML that redirects to your Flutter custom URI
  res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      `
      <script>
        // Serialize the payload into query params
        const params = new URLSearchParams(${JSON.stringify(data)}).toString();
        // Redirect to Flutter’s paymentresult:// scheme
        location.href = "paymentresult://callback?" + params;
      </script>
      `
  );
});