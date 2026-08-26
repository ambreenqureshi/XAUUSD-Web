// Vercel Serverless Function
// Proxies requests to OANDA's v20 API so the API token never reaches the browser.
// Set OANDA_API_TOKEN as an Environment Variable in your Vercel project settings.

module.exports = async function handler(req, res) {
  const { granularity = "M15", count = "300" } = req.query;
  const token = process.env.OANDA_API_TOKEN;

  if (!token) {
    res.status(500).json({ error: "OANDA_API_TOKEN is not set in Vercel environment variables." });
    return;
  }

  const url = `https://api-fxpractice.oanda.com/v3/instruments/XAU_USD/candles?granularity=${granularity}&count=${count}&price=M`;

  try {
    const oandaRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await oandaRes.json();

    if (!oandaRes.ok) {
      res.status(oandaRes.status).json(data);
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
