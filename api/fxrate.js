// Vercel Serverless Function
// Proxies the GBP/USD exchange rate request server-side to avoid any
// browser CORS restrictions on the client-side fetch.

module.exports = async function handler(req, res) {
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?from=GBP&to=USD");
    const data = await r.json();

    if (!r.ok) {
      res.status(r.status).json(data);
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
