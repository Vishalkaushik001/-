// server.js
const express = require('express');
const fetch = require('node-fetch'); // v2 syntax
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const sanitizeHtml = require('sanitize-html');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Helper: make absolute URLs for resources
function toAbsolute(resourceUrl, base) {
  try {
    return new url.URL(resourceUrl, base).toString();
  } catch (e) {
    return resourceUrl;
  }
}

// Endpoint to fetch & clean page
app.post('/fetch', async (req, res) => {
  try {
    const { target } = req.body;
    if (!target || !/^https?:\/\//i.test(target)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // fetch page
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'AdFreeProxy/1.0 (+https://example.com)'
      },
      timeout: 15000
    });
    if (!resp.ok) return res.status(502).json({ error: 'Failed to fetch target' });

    const html = await resp.text();

    // Parse with jsdom
    const dom = new JSDOM(html, { url: target });
    const doc = dom.window.document;

    // Remove known ad script/selectors quickly (best-effort)
    // NOTE: This is a simple sweep; more rules can be added.
    [
      'script', 'iframe', 'ins', 'amp-ad', 'amp-analytics',
      'link[rel="preload"][as="script"]'
    ].forEach(sel => {
      doc.querySelectorAll(sel).forEach(n => n.remove());
    });

    // Remove elements that look like ads by class/id patterns
    const adPatterns = [/advert/i, /ads?/i, /banner/i, /sponsored/i, /promoted/i];
    doc.querySelectorAll('*').forEach(el => {
      const id = el.id || '';
      const cls = (el.className && typeof el.className === 'string') ? el.className : '';
      for (const p of adPatterns) {
        if (p.test(id) || p.test(cls)) { el.remove(); break; }
      }
    });

    // Use Readability to extract article content (best for article-style pages)
    let contentHtml = null;
    try {
      const reader = new Readability(doc);
      const article = reader.parse();
      if (article && article.content) {
        contentHtml = `<h1>${article.title || ''}</h1>\n${article.content}`;
      }
    } catch (e) {
      // fallback: use body
    }

    // If readability failed or returned thin content, fallback to sanitized body
    if (!contentHtml) {
      // Make links/images absolute
      doc.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        if (href) a.setAttribute('href', toAbsolute(href, target));
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('target', '_blank');
      });
      doc.querySelectorAll('img').forEach(img => {
        const s = img.getAttribute('src');
        if (s) img.setAttribute('src', toAbsolute(s, target));
      });
      contentHtml = doc.body ? doc.body.innerHTML : html;
    }

    // Sanitize the HTML: allow safe tags and attributes
    const clean = sanitizeHtml(contentHtml, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'table', 'thead', 'tbody', 'tr', 'th', 'td']),
      allowedAttributes: {
        a: ['href', 'name', 'target', 'rel'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        '*': ['class', 'id', 'style']
      },
      // transform relative URLs to absolute for images/links already attempted above,
      // but further rewriting could be done here.
    });

    // Build a simple page wrapper with original URL visible and a "Open original" link
    const wrapper = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>Ad-free view — ${sanitizeHtml(target)}</title>
          <style>
            body{font-family:Inter,Arial,sans-serif;line-height:1.6;padding:22px;max-width:900px;margin:auto;background:#fbfbfd;color:#111}
            header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
            a.btn{background:#1f6feb;color:#fff;padding:8px 12px;border-radius:8px;text-decoration:none}
            img{max-width:100%;height:auto}
          </style>
        </head>
        <body>
          <header>
            <div>
              <div style="font-size:13px;color:#666">Ad-free view</div>
              <div style="font-weight:700">${sanitizeHtml(target)}</div>
            </div>
            <div>
              <a class="btn" href="${encodeURI(target)}" target="_blank" rel="noopener noreferrer">Open original</a>
            </div>
          </header>
          <main>${clean}</main>
          <footer style="margin-top:40px;color:#666;font-size:13px">
            <div>Served by AdFree Proxy</div>
            <div style="margin-top:8px">Note: dynamic sites or paywalled content may not render correctly.</div>
          </footer>
        </body>
      </html>
    `;

    // Send wrapper HTML
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(wrapper);

  } catch (err) {
    console.error('fetch error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Ad-free proxy running on http://localhost:${PORT}`);
});
