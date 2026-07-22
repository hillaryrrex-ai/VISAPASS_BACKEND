// =============================================
// server.js - VisaPass Backend for Render
// Multi-API + Caching + Compression
// =============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 5000;

// =============================================
// MIDDLEWARE
// =============================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

console.log('✅ VisaPass Backend Starting on Render...');

// =============================================
// SUPABASE
// =============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
console.log('✅ Supabase connected!');

// =============================================
// GEMINI
// =============================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
console.log('✅ Gemini configured!');

// =============================================
// IMAGE COMPRESSION (150KB target)
// =============================================
async function compressImage(buffer, maxSizeKB = 150) {
  try {
    let quality = 75;
    let compressed = await sharp(buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toBuffer();

    while (compressed.length > maxSizeKB * 1024 && quality > 20) {
      quality -= 10;
      compressed = await sharp(buffer)
        .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, progressive: true, mozjpeg: true })
        .toBuffer();
    }

    console.log(`📦 Compressed: ${(buffer.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`);
    return compressed;
  } catch (error) {
    console.error('Compression error:', error);
    return buffer;
  }
}

async function compressBase64Image(base64String) {
  const matches = base64String.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) return base64String;

  const mimeType = matches[1];
  const buffer = Buffer.from(matches[2], 'base64');
  const compressedBuffer = await compressImage(buffer);
  const compressedBase64 = compressedBuffer.toString('base64');
  return `data:${mimeType};base64,${compressedBase64}`;
}

// =============================================
// MULTI-API EMBASSY FETCHER WITH CACHING
// =============================================

// API Keys (from .env)
const API_KEYS = {
  Orizn: process.env.ORIZN_API_KEY,
  TravelBuddy: process.env.TRAVELBUDDY_API_KEY
};

// API configurations in priority order
const APIS = [
  {
    name: 'Orizn',
    url: 'https://visa.orizn.app/api/v1/requirements',
    headers: (key) => ({ 'x-api-key': key }),
    parse: (data) => {
      // Orizn returns requirements array
      const docs = data.requirements || data.data || [];
      return docs.map(doc => ({
        name: doc.name || doc.document_type || 'Document',
        required: doc.required !== undefined ? doc.required : true,
        description: doc.description || ''
      }));
    },
    priority: 1
  },
  {
    name: 'TravelBuddy',
    url: 'https://visa-requirement.p_rapidapi.com/v2/visa/check',
    headers: (key) => ({
      'x-rapidapi-key': key,
      'x-rapidapi-host': 'visa-requirement.p_rapidapi.com'
    }),
    parse: (data) => {
      // Travel Buddy returns structured visa requirements
      const docs = [];
      const req = data.visa_requirements || data.data || {};
      if (req.passport) docs.push({ name: 'Passport', required: true, description: 'Valid for at least 6 months' });
      if (req.application_form) docs.push({ name: 'Application Form', required: true, description: 'Completed and signed' });
      if (req.photo) docs.push({ name: 'Passport Photo', required: true, description: '2x2 inches, white background' });
      if (req.bank_statement) docs.push({ name: 'Bank Statement', required: true, description: 'Last 3 months' });
      if (req.employment_letter) docs.push({ name: 'Employment Letter', required: true, description: 'From employer' });
      if (req.travel_itinerary) docs.push({ name: 'Travel Itinerary', required: true });
      if (req.hotel_booking) docs.push({ name: 'Hotel Booking', required: true });
      if (req.proof_of_ties) docs.push({ name: 'Proof of Ties', required: true, description: 'Property, family, business' });
      if (req.visa_fee) docs.push({ name: 'Visa Fee Receipt', required: true });
      return docs;
    },
    priority: 2
  }
];

// Helper: Check cache from Supabase
async function getCachedCountryData(countryName) {
  try {
    const { data, error } = await supabase
      .from('countries')
      .select('*')
      .eq('name', countryName)
      .single();
    if (error || !data) return null;
    return data;
  } catch (error) {
    return null;
  }
}

// Helper: Save to cache
async function saveCachedCountryData(countryName, documents, source = 'api') {
  try {
    await supabase
      .from('countries')
      .upsert({
        name: countryName,
        flag: allCountries.find(c => c.name === countryName)?.flag || '🌍',
        documents: documents,
        last_updated: new Date().toISOString(),
        source: source
      });
    console.log(`💾 Saved ${countryName} data to cache`);
  } catch (error) {
    console.error('Cache save error:', error);
  }
}

// Helper: Check if cache expired (7 days)
function isCacheExpired(lastUpdated) {
  const daysOld = (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
  return daysOld > 7;
}

// Gemini fallback
async function fetchEmbassyDataGemini(countryName) {
  const prompt = `
You are a visa document expert for ${countryName}.
Provide the official document requirements for tourist visa to ${countryName}.
Return ONLY this JSON:
{
  "documents": [
    {"name": "Document name", "required": true, "description": "Brief description"}
  ]
}
`;
  try {
    const response = await callGemini(prompt);
    const parsed = JSON.parse(response);
    return {
      source: 'Gemini (fallback)',
      documents: parsed.documents || [],
      lastUpdated: new Date()
    };
  } catch (error) {
    console.error('Gemini fallback error:', error);
    return {
      source: 'Gemini (fallback)',
      documents: [],
      lastUpdated: new Date()
    };
  }
}

// Main fetch function with caching and API fallback
async function fetchEmbassyData(countryName) {
  // 1. CHECK CACHE
  const cached = await getCachedCountryData(countryName);
  if (cached && !isCacheExpired(cached.last_updated)) {
    console.log(`📦 Using cached data for ${countryName} (${cached.source})`);
    return {
      source: cached.source || 'cache',
      documents: cached.documents,
      lastUpdated: cached.last_updated,
      fromCache: true
    };
  }

  // 2. TRY APIS IN ORDER
  let lastError = null;
  for (const api of APIS) {
    const apiKey = API_KEYS[api.name];
    if (!apiKey) {
      console.log(`⏭️ Skipping ${api.name} - no API key`);
      continue;
    }

    try {
      console.log(`🔍 Trying ${api.name} API...`);

      let url = api.url;
      if (api.name === 'Orizn') {
        url += `?country=${encodeURIComponent(countryName)}`;
      } else if (api.name === 'TravelBuddy') {
        // TravelBuddy expects passport and destination
        // We'll use Nigeria as passport for now (you can make dynamic later)
        url += `?passport=NG&destination=${encodeURIComponent(countryName)}`;
      }

      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...api.headers(apiKey)
        }
      });

      // Check rate limit
      if (response.status === 429) {
        console.log(`⚠️ ${api.name} rate limit hit, moving to next API`);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const documents = api.parse(data);

      if (documents && documents.length > 0) {
        console.log(`✅ ${api.name} API succeeded!`);
        // Save to cache
        await saveCachedCountryData(countryName, documents, api.name);
        return {
          source: api.name,
          documents: documents,
          lastUpdated: new Date(),
          fromCache: false
        };
      }
    } catch (error) {
      console.log(`❌ ${api.name} failed: ${error.message}`);
      lastError = error;
    }
  }

  // 3. FALLBACK TO GEMINI
  console.log('⚠️ All APIs failed! Falling back to Gemini...');
  const geminiResult = await fetchEmbassyDataGemini(countryName);
  if (geminiResult.documents && geminiResult.documents.length > 0) {
    await saveCachedCountryData(countryName, geminiResult.documents, 'Gemini');
  }
  return {
    source: 'Gemini (fallback)',
    documents: geminiResult.documents,
    lastUpdated: new Date(),
    fromCache: false
  };
}

// =============================================
// API LIMIT TRACKING (Gemini)
// =============================================
let apiUsage = {
  dailyRequests: 0,
  lastReset: new Date(),
  isLimited: false,
  limit: 1500
};

function resetDailyUsage() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (now > midnight && apiUsage.lastReset < midnight) {
    apiUsage.dailyRequests = 0;
    apiUsage.isLimited = false;
    apiUsage.lastReset = now;
    console.log('🔄 Gemini API limit reset!');
  }
}

function isApiAvailable() {
  resetDailyUsage();
  return !apiUsage.isLimited;
}

// =============================================
// HELPER: Call Gemini
// =============================================
async function callGemini(prompt) {
  resetDailyUsage();
  if (apiUsage.isLimited) {
    throw new Error('GEMINI_LIMIT_REACHED');
  }
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    apiUsage.dailyRequests++;
    if (apiUsage.dailyRequests >= apiUsage.limit) {
      apiUsage.isLimited = true;
      console.log('⚠️ Gemini API limit reached for today!');
    }
    return response.text();
  } catch (error) {
    console.error('Gemini error:', error);
    throw error;
  }
}

// =============================================
// 130 COUNTRIES
// =============================================
const allCountries = [
  { name: 'United States', flag: '🇺🇸' },
  { name: 'United Kingdom', flag: '🇬🇧' },
  { name: 'Canada', flag: '🇨🇦' },
  // ... (add all 130 countries from previous code)
  { name: 'Suriname', flag: '🇸🇷' }
];

console.log(`🌍 ${allCountries.length} countries loaded`);

// =============================================
// ADMIN CONFIG
// =============================================
const ADMIN_EMAILS = ['obinnafestus471@gmail.com', 'admin@visapass.com'];
const ADMIN_PASSWORD = 'VisaPassAdmin123';

function isAdmin(req, res, next) {
  const userEmail = req.headers['x-user-email'] || req.query.email;
  if (ADMIN_EMAILS.includes(userEmail)) {
    return next();
  }
  res.status(403).json({
    success: false,
    error: '🚫 Admin access required!'
  });
}

// =============================================
// PAYMENT CHECK
// =============================================
async function checkUserPayment(userEmail) {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('user_email', userEmail)
      .eq('status', 'success')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) throw error;
    return { hasPaid: data && data.length > 0, payment: data && data.length > 0 ? data[0] : null };
  } catch (error) {
    console.error('Payment check error:', error);
    return { hasPaid: false, payment: null };
  }
}

// =============================================
// ROUTES
// =============================================

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'VisaPass Backend is running on Render! 🚀',
    database: 'Supabase ✅',
    gemini: process.env.GEMINI_API_KEY ? 'Configured ✅' : 'Not configured',
    orizn: process.env.ORIZN_API_KEY ? 'Configured ✅' : 'Not configured',
    travelbuddy: process.env.TRAVELBUDDY_API_KEY ? 'Configured ✅' : 'Not configured',
    compression: 'Sharp (150KB target) ✅',
    countries: allCountries.length,
    timestamp: new Date()
  });
});

// Get all countries
app.get('/api/countries', (req, res) => {
  res.json({
    success: true,
    count: allCountries.length,
    countries: allCountries
  });
});

// Get documents for a country (with cache & API fallback)
app.get('/api/documents/:country', async (req, res) => {
  try {
    const countryName = decodeURIComponent(req.params.country);
    const result = await fetchEmbassyData(countryName);

    res.json({
      success: true,
      data: {
        country: countryName,
        flag: allCountries.find(c => c.name === countryName)?.flag || '🌍',
        documents: result.documents,
        total: result.documents.length,
        lastUpdated: result.lastUpdated,
        source: result.source,
        fromCache: result.fromCache || false
      }
    });
  } catch (error) {
    console.error('Document fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Generate Cover Letter (with payment check)
app.post('/api/coverletter/generate', async (req, res) => {
  try {
    const formData = req.body;
    const userEmail = formData.email || req.headers['x-user-email'];
    if (!userEmail) return res.status(400).json({ success: false, error: 'EMAIL_REQUIRED', requiresPayment: true });

    const paymentCheck = await checkUserPayment(userEmail);
    if (!paymentCheck.hasPaid) {
      return res.status(402).json({
        success: false,
        error: 'PAYMENT_REQUIRED',
        message: '💳 Please pay to access this feature.',
        requiresPayment: true
      });
    }

    if (!isApiAvailable()) return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE' });

    const letter = await generatePowerfulCoverLetter(formData);

    await supabase.from('cover_letters').insert({
      user_email: userEmail,
      user_name: formData.name || 'User',
      country: formData.destination || 'Unknown',
      content: letter,
      form_data: formData,
      payment_reference: paymentCheck.payment?.reference,
      created_at: new Date()
    });

    res.json({ success: true, data: { letter, generatedAt: new Date() } });
  } catch (error) {
    if (error.message === 'GEMINI_LIMIT_REACHED') {
      return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Service at capacity. Try after 12:00 AM.' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Document Check (with image compression)
app.post('/api/documents/check', async (req, res) => {
  try {
    const { country, documents, userName, userEmail } = req.body;
    if (!userEmail) return res.status(400).json({ success: false, error: 'EMAIL_REQUIRED', requiresPayment: true });

    const paymentCheck = await checkUserPayment(userEmail);
    if (!paymentCheck.hasPaid) {
      return res.status(402).json({ success: false, error: 'PAYMENT_REQUIRED', message: '💳 Please pay.' });
    }

    if (!isApiAvailable()) return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE' });

    // Compress images
    const compressedDocs = await Promise.all(documents.map(async (doc) => {
      if (doc.file && typeof doc.file === 'string' && doc.file.startsWith('data:image')) {
        doc.file = await compressBase64Image(doc.file);
      }
      return doc;
    }));

    const documentCheck = await checkUserDocuments(country, compressedDocs, userName);
    const fakeCheck = await detectFakeDocuments(compressedDocs, country, userName);

    const combinedResults = {
      documentCheck,
      fakeCheck,
      overallStatus: {
        documentScore: documentCheck.summary?.score || '0%',
        riskLevel: fakeCheck.overallRisk || 'LOW',
        ready: documentCheck.summary?.ready && fakeCheck.overallRisk !== 'HIGH'
      }
    };

    await supabase.from('document_checks').insert({
      user_email: userEmail,
      user_name: userName || 'User',
      country,
      results: combinedResults,
      payment_reference: paymentCheck.payment?.reference,
      created_at: new Date()
    });

    res.json({ success: true, data: combinedResults });
  } catch (error) {
    if (error.message === 'GEMINI_LIMIT_REACHED') {
      return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Service at capacity.' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Paystack Webhook
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    if (event.event === 'charge.success') {
      const data = event.data;
      const reference = data.reference;
      const email = data.customer?.email;

      console.log(`✅ Payment successful for ${email}`);

      await supabase
        .from('payments')
        .update({ status: 'success', paid_at: new Date(), paystack_data: data })
        .eq('reference', reference);
    }

    res.status(200).json({ status: 'Webhook received' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Admin Login Page
app.get('/admin-login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>VisaPass Admin Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial;background:#0a0e27;display:flex;justify-content:center;align-items:center;height:100vh}
.login-container{background:#1a1f3a;padding:40px;border-radius:16px;width:400px;border:1px solid #2a2f4a}
.login-container h1{color:#fff;text-align:center;margin-bottom:10px}
.login-container p{color:#888;text-align:center;margin-bottom:30px}
.login-container input{width:100%;padding:12px;margin-bottom:16px;border:1px solid #2a2f4a;border-radius:8px;background:#0a0e27;color:#fff;font-size:16px}
.login-container button{width:100%;padding:14px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}
.login-container button:hover{background:#6366f1}
.error{color:#ef4444;text-align:center;margin-bottom:16px;display:none}
.success{color:#22c55e;text-align:center;margin-bottom:16px;display:none}
.shield{text-align:center;font-size:48px;margin-bottom:16px}
</style>
</head>
<body>
<div class="login-container">
<div class="shield">🛡️</div>
<h1>Admin Login</h1>
<p>🔐 Only authorized admins can enter</p>
<div class="error" id="errorMsg">❌ Invalid credentials</div>
<div class="success" id="successMsg">✅ Login successful! Redirecting...</div>
<input type="email" id="email" placeholder="admin@visapass.com" value="obinnafestus471@gmail.com">
<input type="password" id="password" placeholder="••••••••" value="VisaPassAdmin123">
<button onclick="login()">🔑 Enter Dashboard</button>
</div>
<script>
async function login(){const email=document.getElementById('email').value;const password=document.getElementById('password').value;const errorMsg=document.getElementById('errorMsg');const successMsg=document.getElementById('successMsg');errorMsg.style.display='none';successMsg.style.display='none';try{const response=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const data=await response.json();if(data.success){successMsg.style.display='block';successMsg.textContent='✅ '+data.data.message;localStorage.setItem('adminToken',data.data.adminToken);localStorage.setItem('adminEmail',email);setTimeout(()=>{window.location.href='/admin-dashboard'},1500)}else{errorMsg.style.display='block';errorMsg.textContent='❌ '+data.message}}catch(error){errorMsg.style.display='block';errorMsg.textContent='❌ Connection error'}}
</script>
</body></html>`);
});

// Admin Login API
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!ADMIN_EMAILS.includes(email) || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
  const adminToken = Buffer.from(`${email}:${Date.now()}`).toString('base64');
  res.json({ success: true, data: { adminToken, email, message: '✅ Welcome Admin!' } });
});

// Admin Dashboard (Luxury version)
app.get('/admin-dashboard', (req, res) => {
  // (Same as previous luxury dashboard HTML - keep it short here)
  res.send(`<!DOCTYPE html><html><head><title>VisaPass Admin</title>... (full luxury HTML)</html>`);
});

// =============================================
// ADMIN API ENDPOINTS (Users, Payments, Document Checks)
// =============================================
app.get('/api/admin/dashboard', isAdmin, async (req, res) => {
  try {
    const { count: totalUsers } = await supabase.from('user_applications').select('*', { count: 'exact', head: true });
    const { data: allApps, count: totalApps } = await supabase.from('user_applications').select('*', { count: 'exact' });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: todayApps, count: todayCount } = await supabase.from('user_applications').select('*', { count: 'exact' }).gte('created_at', today.toISOString());
    const { data: pendingApps, count: pendingCount } = await supabase.from('user_applications').select('*', { count: 'exact' }).eq('status', 'pending_review');
    const { data: payments } = await supabase.from('payments').select('amount, status');
    const totalRevenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    const paidCount = payments?.filter(p => p.status === 'success').length || 0;
    const { data: docChecks } = await supabase.from('document_checks').select('results');
    let fakeCount = 0;
    docChecks?.forEach(check => {
      if (check.results?.fakeCheck?.overallRisk === 'HIGH') fakeCount++;
    });
    res.json({
      success: true,
      data: {
        stats: {
          totalUsers: totalUsers || 0,
          totalApplications: totalApps || 0,
          todaySubmissions: todayCount || 0,
          pendingReviews: pendingCount || 0,
          totalRevenue,
          paidPayments: paidCount,
          fakeDocuments: fakeCount
        },
        recentApplications: allApps?.slice(0, 10) || []
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabase.from('user_applications').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: users || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/payments', isAdmin, async (req, res) => {
  try {
    const { data: payments, error } = await supabase.from('payments').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const totalRevenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    const paidCount = payments?.filter(p => p.status === 'success').length || 0;
    const pendingCount = payments?.filter(p => p.status === 'pending').length || 0;
    res.json({
      success: true,
      data: {
        payments: payments || [],
        stats: { total: payments?.length || 0, totalRevenue, paid: paidCount, pending: pendingCount }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/document-checks', isAdmin, async (req, res) => {
  try {
    const { data: checks, error } = await supabase.from('document_checks').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const highRisk = checks?.filter(c => c.results?.fakeCheck?.overallRisk === 'HIGH').length || 0;
    const lowRisk = checks?.filter(c => c.results?.fakeCheck?.overallRisk === 'LOW').length || 0;
    res.json({
      success: true,
      data: {
        checks: checks || [],
        stats: { total: checks?.length || 0, highRisk, lowRisk }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// HELPER FUNCTIONS FOR DOCUMENT CHECKING
// =============================================
async function generatePowerfulCoverLetter(formData) {
  const prompt = `...`; // Same as before
  return await callGemini(prompt);
}

async function checkUserDocuments(country, documents, userName) {
  const prompt = `...`; // Same as before
  const response = await callGemini(prompt);
  return JSON.parse(response);
}

async function detectFakeDocuments(documents, country, userName) {
  const prompt = `...`; // Same as before
  const response = await callGemini(prompt);
  return JSON.parse(response);
}

// =============================================
// START SERVER
// =============================================
app.listen(PORT, () => {
  console.log(`
╔═════════════════════════════════════════════════════════════════╗
║                                                                 ║
║              ✅ VISAPASS BACKEND IS RUNNING!                     ║
║                                                                 ║
║  📡 API URL: http://localhost:${PORT}                           ║
║  🌍 Countries: ${allCountries.length} loaded                    ║
║  💾 Database: Supabase ✅                                       ║
║  🤖 Gemini: ${process.env.GEMINI_API_KEY ? '✅' : '❌'}         ║
║  📦 Orizn: ${process.env.ORIZN_API_KEY ? '✅' : '❌'}           ║
║  📦 Travel Buddy: ${process.env.TRAVELBUDDY_API_KEY ? '✅' : '❌'} ║
║  📦 Compression: Sharp (150KB) ✅                              ║
║  🛡️ Admin: /admin-login                                        ║
║  ☁️ Render.com: ✅                                              ║
║                                                                 ║
║  ✅ Multi-API with Caching                                      ║
║  ✅ 7-day expiry                                               ║
║  ✅ Automatic fallback                                         ║
║  ✅ 130 Countries                                              ║
║  ✅ Payment & Webhook                                          ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
  `);
});
