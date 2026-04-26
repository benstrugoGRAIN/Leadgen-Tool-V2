const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const DB_PATH = path.join(__dirname, 'feedback.json');

// Initialize feedback DB
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ leads: [], searches: [] }, null, 2));
}

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch(e) { return { leads: [], searches: [] }; }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Anthropic proxy with retry
async function callAnthropic(body, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 529) {
      console.log(`Overloaded, retry ${i + 1}/${retries}...`);
      await new Promise(r => setTimeout(r, 5000 * (i + 1)));
      continue;
    }

    const data = await response.json();
    console.log('Anthropic status:', response.status);
    return { status: response.status, data };
  }
  throw new Error('API overloaded after retries. Please try again.');
}

// Claude API proxy
app.post('/api/claude', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
  try {
    const { status, data } = await callAnthropic(req.body);
    res.status(status).json(data);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Save feedback on a lead
app.post('/api/feedback', (req, res) => {
  const { leadName, domain, searchedCompany, rating, note, status } = req.body;
  const db = readDB();
  const existing = db.leads.findIndex(l => l.leadName === leadName && l.searchedCompany === searchedCompany);
  const entry = {
    leadName,
    domain: domain || '',
    searchedCompany,
    rating,       // 'good' | 'bad' | null
    note: note || '',
    status: status || 'new',  // 'new' | 'contacted' | 'won' | 'lost'
    updatedAt: new Date().toISOString()
  };
  if (existing > -1) db.leads[existing] = entry;
  else db.leads.push(entry);
  writeDB(db);
  res.json({ ok: true });
});

// Get all feedback
app.get('/api/feedback', (req, res) => {
  const db = readDB();
  res.json(db.leads);
});

// Update lead status only
app.post('/api/status', (req, res) => {
  const { leadName, searchedCompany, status } = req.body;
  const db = readDB();
  const existing = db.leads.findIndex(l => l.leadName === leadName && l.searchedCompany === searchedCompany);
  if (existing > -1) {
    db.leads[existing].status = status;
    db.leads[existing].updatedAt = new Date().toISOString();
  } else {
    db.leads.push({ leadName, searchedCompany, status, rating: null, note: '', updatedAt: new Date().toISOString() });
  }
  writeDB(db);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Lead Finder v2 running on port ' + PORT));
