const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'feedback.json');
const HS_CACHE_PATH = path.join(DATA_DIR, 'hubspot_cache.json');

console.log('Using DB path:', DB_PATH);

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

function readHSCache() {
  try { return JSON.parse(fs.readFileSync(HS_CACHE_PATH, 'utf8')); }
  catch(e) { return null; }
}

function writeHSCache(data) {
  fs.writeFileSync(HS_CACHE_PATH, JSON.stringify(data, null, 2));
}

// HubSpot fetch helper
async function hubspotGet(url) {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`HubSpot error: ${res.status}`);
  return res.json();
}

// Pull all HubSpot data
async function syncHubspot() {
  if (!HUBSPOT_TOKEN) {
    console.log('No HubSpot token configured, skipping sync');
    return null;
  }

  console.log('Syncing HubSpot data...');
  try {
    // Fetch companies with key properties
    const companiesRes = await hubspotGet(
      'https://api.hubapi.com/crm/v3/objects/companies?limit=100&properties=name,domain,industry,numberofemployees,country,annualrevenue,hubspot_owner_id'
    );

    // Fetch deals with stage info
    const dealsRes = await hubspotGet(
      'https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,dealstage,closedate,amount,pipeline,associated_company'
    );

    // Fetch contacts with key properties
    const contactsRes = await hubspotGet(
      'https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email,jobtitle,company,hs_lead_status'
    );

    // Fetch deal pipelines to understand stage names
    const pipelinesRes = await hubspotGet(
      'https://api.hubapi.com/crm/v3/pipelines/deals'
    );

    // Build stage name map
    const stageMap = {};
    (pipelinesRes.results || []).forEach(pipeline => {
      (pipeline.stages || []).forEach(stage => {
        stageMap[stage.id] = { 
          label: stage.label, 
          pipeline: pipeline.label,
          probability: stage.metadata?.probability || 0
        };
      });
    });

    // Categorize deals
    const wonDeals = [];
    const lostDeals = [];
    const activDeals = [];

    (dealsRes.results || []).forEach(deal => {
      const stage = stageMap[deal.properties?.dealstage] || {};
      const stageLabel = (stage.label || '').toLowerCase();
      const entry = {
        name: deal.properties?.dealname || '',
        stage: stage.label || deal.properties?.dealstage,
        amount: deal.properties?.amount,
        closedate: deal.properties?.closedate
      };
      if (stageLabel.includes('won') || stageLabel.includes('closed won')) wonDeals.push(entry);
      else if (stageLabel.includes('lost') || stageLabel.includes('closed lost')) lostDeals.push(entry);
      else activDeals.push(entry);
    });

    const cache = {
      syncedAt: new Date().toISOString(),
      companies: (companiesRes.results || []).map(c => ({
        name: c.properties?.name || '',
        domain: c.properties?.domain || '',
        industry: c.properties?.industry || '',
        employees: c.properties?.numberofemployees || '',
        country: c.properties?.country || '',
        revenue: c.properties?.annualrevenue || ''
      })),
      wonDeals,
      lostDeals,
      activeDeals: activDeals,
      contacts: (contactsRes.results || []).map(c => ({
        name: `${c.properties?.firstname || ''} ${c.properties?.lastname || ''}`.trim(),
        email: c.properties?.email || '',
        title: c.properties?.jobtitle || '',
        company: c.properties?.company || '',
        status: c.properties?.hs_lead_status || ''
      }))
    };

    writeHSCache(cache);
    console.log(`HubSpot sync done: ${cache.companies.length} companies, ${wonDeals.length} won, ${lostDeals.length} lost, ${activDeals.length} active deals`);
    return cache;
  } catch(e) {
    console.log('HubSpot sync error:', e.message);
    return null;
  }
}

// Run sync on startup + every 24 hours
syncHubspot();
setInterval(syncHubspot, 24 * 60 * 60 * 1000);

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

// Get HubSpot context for prompts
app.get('/api/hubspot-context', (req, res) => {
  const cache = readHSCache();
  if (!cache) return res.json({ available: false, syncedAt: null });
  res.json({ 
    available: true, 
    syncedAt: cache.syncedAt,
    summary: {
      companies: cache.companies.length,
      wonDeals: cache.wonDeals.length,
      lostDeals: cache.lostDeals.length,
      activeDeals: cache.activeDeals.length,
      contacts: cache.contacts.length
    },
    context: buildHubspotContext(cache)
  });
});

// Manual sync trigger
app.post('/api/hubspot-sync', async (req, res) => {
  const result = await syncHubspot();
  if (result) res.json({ ok: true, syncedAt: result.syncedAt, summary: { companies: result.companies.length, wonDeals: result.wonDeals.length, lostDeals: result.lostDeals.length } });
  else res.status(500).json({ ok: false, error: 'Sync failed or no HubSpot token' });
});

function buildHubspotContext(cache) {
  if (!cache) return '';
  let ctx = '\n\nHUBSPOT CRM INTELLIGENCE (use this to improve search relevancy):\n';
  
  if (cache.wonDeals.length) {
    ctx += `\nWON DEALS (${cache.wonDeals.length} total) - find more companies like these:\n`;
    ctx += cache.wonDeals.slice(0, 20).map(d => `- ${d.name}${d.amount ? ' ($'+d.amount+')' : ''}`).join('\n') + '\n';
  }
  
  if (cache.lostDeals.length) {
    ctx += `\nLOST DEALS (${cache.lostDeals.length} total) - avoid companies like these:\n`;
    ctx += cache.lostDeals.slice(0, 20).map(d => `- ${d.name}`).join('\n') + '\n';
  }
  
  if (cache.activeDeals.length) {
    ctx += `\nACTIVE PIPELINE (${cache.activeDeals.length} deals) - already being worked, deprioritize similar:\n`;
    ctx += cache.activeDeals.slice(0, 15).map(d => `- ${d.name} (${d.stage})`).join('\n') + '\n';
  }

  if (cache.companies.length) {
    const industries = [...new Set(cache.companies.map(c => c.industry).filter(Boolean))];
    const countries = [...new Set(cache.companies.map(c => c.country).filter(Boolean))];
    if (industries.length) ctx += `\nTop industries in CRM: ${industries.slice(0,10).join(', ')}\n`;
    if (countries.length) ctx += `Top geographies in CRM: ${countries.slice(0,10).join(', ')}\n`;
  }

  return ctx;
}

// Save feedback
app.post('/api/feedback', (req, res) => {
  const { leadName, domain, searchedCompany, rating, note, status } = req.body;
  const db = readDB();
  const existing = db.leads.findIndex(l => l.leadName === leadName && l.searchedCompany === searchedCompany);
  const entry = { leadName, domain: domain||'', searchedCompany, rating, note: note||'', status: status||'new', updatedAt: new Date().toISOString() };
  if (existing > -1) db.leads[existing] = entry; else db.leads.push(entry);
  writeDB(db);
  res.json({ ok: true });
});

// Get all feedback
app.get('/api/feedback', (req, res) => {
  const db = readDB();
  res.json(db.leads);
});

// Update status
app.post('/api/status', (req, res) => {
  const { leadName, searchedCompany, status } = req.body;
  const db = readDB();
  const existing = db.leads.findIndex(l => l.leadName === leadName && l.searchedCompany === searchedCompany);
  if (existing > -1) { db.leads[existing].status = status; db.leads[existing].updatedAt = new Date().toISOString(); }
  else db.leads.push({ leadName, searchedCompany, status, rating: null, note: '', updatedAt: new Date().toISOString() });
  writeDB(db);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Lead Finder v2 running on port ' + PORT));
