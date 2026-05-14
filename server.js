import express from 'express';
import bodyParser from 'body-parser';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
let sessionCounter = 0;

function humanDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function createBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1366,768',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

async function humanizePage(page) {
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, error: 'Username and password required' });
  }

  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    await humanizePage(page);

    await page.goto('https://accounts.snapchat.com/accounts/login', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await humanDelay(800, 1500);

    await page.waitForSelector('input[name="username"]', { visible: true, timeout: 15000 });

    await page.click('input[name="username"]', { clickCount: 3 });
    await page.type('input[name="username"]', username, { delay: 80 + Math.random() * 120 });

    await humanDelay(400, 800);

    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', password, { delay: 80 + Math.random() * 120 });

    await humanDelay(300, 600);

    const loginBtn = await page.$('button[type="submit"]');
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await humanDelay(4000, 6000);

    const currentUrl = page.url();

    if (currentUrl.includes('accounts.snapchat.com/accounts/login')) {
      const otpInput = await page.$('input[name="code"], input[data-testid="otp-input"], input[placeholder*="code" i], input[placeholder*="verification" i]').catch(() => null);
      const otpPrompt = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('verification code') || text.includes('two-factor') || text.includes('2fa') || text.includes('authenticate') || text.includes('security code');
      });

      if (otpInput || otpPrompt) {
        const sessionId = ++sessionCounter;
        sessions.set(sessionId, { browser, page, username });

        setTimeout(() => {
          const s = sessions.get(sessionId);
          if (s) {
            sessions.delete(sessionId);
            s.browser.close().catch(() => {});
          }
        }, 300000);

        return res.json({
          success: false,
          needsVerification: true,
          sessionId: sessionId,
          message: 'Verification code required. Check your email/SMS and enter the code.',
        });
      }

      const errorText = await page.evaluate(() => {
        const selectors = ['.error-msg', '.alert-danger', '[data-testid="error-message"]', '.form-error', '.notification-error', '.error-text'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return null;
      });

      await browser.close();

      if (errorText) {
        const lower = errorText.toLowerCase();
        if (lower.includes('incorrect') || lower.includes('wrong') || lower.includes('invalid')) {
          return res.json({ success: false, error: 'Incorrect username or password' });
        }
        if (lower.includes('locked') || lower.includes('suspended') || lower.includes('disabled')) {
          return res.json({ success: false, error: 'Account is locked or suspended' });
        }
        return res.json({ success: false, error: errorText });
      }

      return res.json({ success: false, error: 'Login failed. Please check your credentials.' });
    }

    if (currentUrl.includes('web.snapchat.com') || currentUrl.includes('accounts.snapchat.com/accounts/welcome')) {
      const displayName = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="user-display-name"], .user-name, [class*="displayName"], [class*="account-name"]');
        return el ? el.textContent.trim() : null;
      }).catch(() => null);

      await browser.close();

      return res.json({
        success: true,
        message: 'Login successful!',
        displayName: displayName || username,
      });
    }

    await browser.close();
    return res.json({ success: false, error: 'Unexpected redirect: ' + currentUrl });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ success: false, error: err.message || 'Unknown error' });
  }
});

app.post('/api/verify', async (req, res) => {
  const { sessionId, code } = req.body;
  if (!sessionId || !code) {
    return res.json({ success: false, error: 'Session ID and verification code required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.json({ success: false, error: 'Session expired or not found. Please login again.' });
  }

  try {
    const { browser, page } = session;

    const otpInput = await page.$('input[name="code"], input[data-testid="otp-input"], input[placeholder*="code" i], input[placeholder*="verification" i]').catch(() => null);

    if (otpInput) {
      await otpInput.click({ clickCount: 3 });
      await humanDelay(200, 400);
      await otpInput.type(code, { delay: 100 + Math.random() * 80 });
    } else {
      const allInputs = await page.$$('input');
      for (const input of allInputs) {
        const type = await input.evaluate(el => el.type || el.getAttribute('type'));
        const placeholder = await input.evaluate(el => el.placeholder || '');
        if (type === 'text' || type === 'number' || placeholder.toLowerCase().includes('code')) {
          await input.click({ clickCount: 3 });
          await humanDelay(200, 400);
          await input.type(code, { delay: 100 + Math.random() * 80 });
          break;
        }
      }
    }

    await humanDelay(400, 700);

    const submitBtn = await page.$('button[type="submit"], button[class*="primary"], button[class*="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await humanDelay(5000, 7000);

    const currentUrl = page.url();

    sessions.delete(sessionId);

    if (currentUrl.includes('web.snapchat.com') || currentUrl.includes('accounts.snapchat.com/accounts/welcome') || !currentUrl.includes('login')) {
      const displayName = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="user-display-name"], .user-name, [class*="displayName"], [class*="account-name"]');
        return el ? el.textContent.trim() : null;
      }).catch(() => null);

      await browser.close();

      return res.json({
        success: true,
        message: 'Login successful! Verification code accepted.',
        displayName: displayName || session.username,
      });
    }

    if (currentUrl.includes('accounts.snapchat.com/accounts/login')) {
      const errorText = await page.evaluate(() => {
        const selectors = ['.error-msg', '.alert-danger', '[data-testid="error-message"]', '.form-error'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return null;
      });

      await browser.close();

      if (errorText) {
        return res.json({ success: false, error: 'Verification failed: ' + errorText });
      }

      return res.json({ success: false, error: 'Invalid verification code. Please try again.' });
    }

    await browser.close();
    return res.json({ success: true, message: 'Login appears successful!', displayName: session.username });

  } catch (err) {
    sessions.delete(sessionId);
    await session.browser.close().catch(() => {});
    return res.json({ success: false, error: err.message || 'Error during verification' });
  }
});

export function startServer(port) {
  app.listen(port, () => {
    console.log(`Snapchat Selfbot running on http://localhost:${port}`);
  });
}
