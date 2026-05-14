import express from 'express';
import axios from 'axios';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { CookieJar } from 'tough-cookie';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'overall.js'));
});

const sessions = new Map();
let sessionCounter = 0;

function humanDelay(ms) {
  return new Promise(r => setTimeout(r, ms + Math.random() * 500));
}

function createAxiosClient() {
  const jar = new CookieJar();
  const client = axios.create({
    timeout: 30000,
    maxRedirects: 10,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  client.interceptors.request.use(async (config) => {
    const cookies = await jar.getCookies(config.url || 'https://accounts.snapchat.com');
    if (cookies.length > 0) {
      config.headers['Cookie'] = cookies.map(c => `${c.key}=${c.value}`).join('; ');
    }
    return config;
  });

  client.interceptors.response.use(async (response) => {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      for (const cookie of setCookie) {
        try {
          await jar.setCookie(cookie, response.config.url || 'https://accounts.snapchat.com');
        } catch {}
      }
    }
    return response;
  });

  return { client, jar };
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, error: 'Username and password required' });
  }

  try {
    const { client, jar } = createAxiosClient();

    const getResp = await client.get('https://accounts.snapchat.com/accounts/login');
    await humanDelay(800);

    const xsrfMatch = getResp.data.match(/name="xsrf_token"[^>]*value="([^"]+)"/);
    const reqTokenMatch = getResp.data.match(/name="req_token"[^>]*value="([^"]+)"/);
    const xsrfToken = xsrfMatch ? xsrfMatch[1] : '';
    const reqToken = reqTokenMatch ? reqTokenMatch[1] : '';

    await humanDelay(600);

    const postData = new URLSearchParams();
    postData.append('username', username);
    postData.append('password', password);
    postData.append('xsrf_token', xsrfToken);
    if (reqToken) postData.append('req_token', reqToken);

    const loginResp = await client.post('https://accounts.snapchat.com/accounts/login', postData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://accounts.snapchat.com/accounts/login',
        'Origin': 'https://accounts.snapchat.com',
      },
    });

    await humanDelay(1000);

    const responseData = loginResp.data;
    const responseUrl = loginResp.request?.res?.responseUrl || '';

    if (responseUrl.includes('web.snapchat.com') || responseUrl.includes('/accounts/welcome')) {
      return res.json({ success: true, message: 'Login successful!', displayName: username });
    }

    if (typeof responseData === 'string') {
      const lower = responseData.toLowerCase();

      if (lower.includes('verification code') || lower.includes('two-factor') || lower.includes('2fa') || lower.includes('otp') || lower.includes('security code') || lower.includes('authenticate')) {
        const sessionId = ++sessionCounter;
        sessions.set(sessionId, { client, jar, username });

        setTimeout(() => {
          const s = sessions.get(sessionId);
          if (s) sessions.delete(sessionId);
        }, 300000);

        return res.json({
          success: false,
          needsVerification: true,
          sessionId: sessionId,
          message: 'Verification code required. Check your email or SMS and enter the code below.',
        });
      }

      if (lower.includes('incorrect') || lower.includes('invalid password') || lower.includes('wrong password')) {
        return res.json({ success: false, error: 'Incorrect username or password' });
      }
      if (lower.includes('locked') || lower.includes('suspended') || lower.includes('disabled') || lower.includes('banned')) {
        return res.json({ success: false, error: 'Account is locked or suspended' });
      }
      if (lower.includes('rate limit') || lower.includes('too many')) {
        return res.json({ success: false, error: 'Rate limited. Try again later.' });
      }
    }

    if (loginResp.status >= 200 && loginResp.status < 400) {
      const cookies = await jar.getCookies('https://accounts.snapchat.com');
      const hasAuthCookie = cookies.some(c =>
        c.key.includes('auth') || c.key.includes('sc_a') || c.key.includes('session') || c.key.includes('token')
      );

      if (hasAuthCookie) {
        return res.json({ success: true, message: 'Login successful!', displayName: username });
      }
    }

    return res.json({ success: false, error: 'Login failed. Please check your credentials.' });

  } catch (err) {
    return res.json({ success: false, error: err.message || 'Network error' });
  }
});

app.post('/api/verify', async (req, res) => {
  const { sessionId, code } = req.body;
  if (!sessionId || !code) {
    return res.json({ success: false, error: 'Session ID and verification code required' });
  }

  const session = sessions.get(parseInt(sessionId));
  if (!session) {
    return res.json({ success: false, error: 'Session expired. Please login again.' });
  }

  try {
    const { client } = session;

    const verifyData = new URLSearchParams();
    verifyData.append('code', code);

    const verifyResp = await client.post('https://accounts.snapchat.com/accounts/otp', verifyData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://accounts.snapchat.com/accounts/login',
        'Origin': 'https://accounts.snapchat.com',
      },
    });

    sessions.delete(parseInt(sessionId));

    const responseUrl = verifyResp.request?.res?.responseUrl || '';
    const responseData = verifyResp.data;

    if (responseUrl.includes('web.snapchat.com') || responseUrl.includes('/accounts/welcome') || !responseUrl.includes('login')) {
      return res.json({ success: true, message: 'Login successful! Code accepted.', displayName: session.username });
    }

    if (typeof responseData === 'string') {
      const lower = responseData.toLowerCase();
      if (lower.includes('invalid') || lower.includes('incorrect') || lower.includes('wrong')) {
        return res.json({ success: false, error: 'Invalid verification code.' });
      }
      if (lower.includes('expired')) {
        return res.json({ success: false, error: 'Code expired. Please login again.' });
      }
    }

    return res.json({ success: true, message: 'Login completed!', displayName: session.username });

  } catch (err) {
    sessions.delete(parseInt(sessionId));
    return res.json({ success: false, error: err.message || 'Verification error' });
  }
});

export function startServer(port) {
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {}
    });
  });

  server.listen(port, () => {
    console.log(`Snapchat Selfbot running on http://localhost:${port}`);
  });
}
