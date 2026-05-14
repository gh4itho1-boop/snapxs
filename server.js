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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

const sessions = new Map();
let sessionCounter = 0;

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function createBrowser() {
  return puppeteer.launch({
    headless: 'new',
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
    window.navigator.chrome = { runtime: {} };
  });
}

async function randomDelay(min, max) {
  await delay(min + Math.random() * (max - min));
}

async function isOtpPage(page) {
  const url = page.url();
  const otpIndicators = await page.evaluate(() => {
    const checks = {
      hasOtpInput: false,
      hasCodeInput: false,
      pageText: '',
      urlContains: location.href,
    };

    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type || '';
      const name = input.name || '';
      const placeholder = (input.placeholder || '').toLowerCase();
      const id = input.id || '';
      const autocomplete = input.getAttribute('autocomplete') || '';

      if (name.includes('otp') || name.includes('code') || name.includes('token') ||
          placeholder.includes('code') || placeholder.includes('verification') || placeholder.includes('digit') ||
          id.includes('otp') || id.includes('code') || id.includes('verify') ||
          autocomplete.includes('one-time-code') || autocomplete.includes('otp')) {
        if (type === 'text' || type === 'number' || type === 'tel' || type === '') {
          checks.hasCodeInput = true;
        }
      }
    }

    const text = document.body.innerText.toLowerCase();
    checks.pageText = text;
    checks.hasOtpInput = text.includes('verification code') || text.includes('two-factor') ||
                         text.includes('2fa') || text.includes('authenticate') ||
                         text.includes('security code') || text.includes('enter code') ||
                         text.includes('otp') || text.includes('confirm your identity') ||
                         text.includes('protect your account');

    return checks;
  });

  return otpIndicators;
}

async function getLoginError(page) {
  return page.evaluate(() => {
    const selectors = [
      '.error-msg', '.alert-danger', '[data-testid="error-message"]',
      '.form-error', '.notification-error', '.error-text',
      '.login-error', '.auth-error', '[role="alert"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }

    const text = document.body.innerText.toLowerCase();
    if (text.includes('incorrect password')) return 'Incorrect username or password';
    if (text.includes('account locked')) return 'Account is locked';
    if (text.includes('account suspended')) return 'Account is suspended';
    if (text.includes('rate limited') || text.includes('too many attempts')) return 'Too many attempts. Try again later.';
    if (text.includes('invalid username')) return 'Invalid username';
    if (text.includes('wrong password')) return 'Wrong password';

    return null;
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

    await randomDelay(2000, 3500);

    const pageContent = await page.content();
    const hasLoginForm = pageContent.includes('password') || pageContent.includes('login') || pageContent.includes('username');
    if (!hasLoginForm) {
      await randomDelay(3000, 5000);
    }

    const findInputs = await page.evaluate(() => {
      const allInputs = Array.from(document.querySelectorAll('input, textarea'));
      let userIdx = -1;
      let passIdx = -1;
      let userEl = null;
      let passEl = null;

      for (let i = 0; i < allInputs.length; i++) {
        const input = allInputs[i];
        const type = input.type || '';
        const tag = input.tagName.toLowerCase();

        if (type === 'password') {
          passIdx = i;
          passEl = input;
          continue;
        }
        if (type === 'hidden' || type === 'submit') continue;

        if (userIdx === -1 && (type === 'text' || type === 'email' || type === 'tel' || tag === 'textarea')) {
          userIdx = i;
          userEl = input;
        }
      }

      const userPath = userEl ? {
        tag: userEl.tagName.toLowerCase(),
        name: userEl.name || '',
        id: userEl.id || '',
        type: userEl.type || '',
        placeholder: userEl.placeholder || '',
        className: userEl.className || '',
      } : null;

      const passPath = passEl ? {
        tag: passEl.tagName.toLowerCase(),
        name: passEl.name || '',
        id: passEl.id || '',
        type: passEl.type || '',
        className: passEl.className || '',
      } : null;

      return { userPath, passPath };
    });

    if (!findInputs.userPath || !findInputs.passPath) {
      await browser.close();
      return res.json({ success: false, error: 'Could not find login form inputs on the Snapchat page.' });
    }

    const buildSelector = (info) => {
      if (info.id) return `${info.tag}#${info.id}`;
      if (info.name) return `${info.tag}[name="${info.name}"]`;
      if (info.placeholder) return `${info.tag}[placeholder="${info.placeholder}"]`;
      return `${info.tag}[type="${info.type}"]`;
    };

    const userSelector = buildSelector(findInputs.userPath);
    const passSelector = buildSelector(findInputs.passPath);

    await randomDelay(300, 600);

    await page.click(userSelector, { clickCount: 3 });
    await randomDelay(200, 400);
    await page.type(userSelector, username, { delay: 60 + Math.random() * 100 });

    await randomDelay(400, 800);

    await page.click(passSelector, { clickCount: 3 });
    await randomDelay(200, 400);
    await page.type(passSelector, password, { delay: 60 + Math.random() * 100 });

    await randomDelay(300, 600);

    const loginBtnSelectors = [
      'button[type="submit"]',
      'button[class*="primary"]',
      'button[class*="login"]',
      'button[class*="submit"]',
      'button[class*="register"]',
      'button:not([type="button"])',
      'button',
      'input[type="submit"]',
    ];

    let loginBtn = null;
    for (const sel of loginBtnSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        const isVisible = await btn.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (isVisible) {
          loginBtn = btn;
          break;
        }
      }
    }

    if (loginBtn) {
      await loginBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await randomDelay(5000, 8000);

    const currentUrl = page.url();

    if (currentUrl.includes('web.snapchat.com') || currentUrl.includes('/accounts/welcome') || currentUrl.includes('/accounts/home')) {
      await browser.close();
      return res.json({ success: true, message: 'Login successful!', displayName: username });
    }

    const otpIndicators = await isOtpPage(page);

    if (otpIndicators.hasCodeInput || otpIndicators.hasOtpInput) {
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
        message: 'Verification code required. Check your email or phone for the code from Snapchat.',
      });
    }

    if (currentUrl.includes('accounts.snapchat.com/accounts/login')) {
      const errorText = await getLoginError(page);
      await browser.close();

      if (errorText) {
        return res.json({ success: false, error: errorText });
      }
      return res.json({ success: false, error: 'Login failed. Check your username and password.' });
    }

    await browser.close();
    return res.json({ success: false, error: 'Unexpected page: ' + currentUrl });

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

  const session = sessions.get(parseInt(sessionId));
  if (!session) {
    return res.json({ success: false, error: 'Session expired or not found. Please login again.' });
  }

  try {
    const { browser, page, username } = session;

    const codeInput = await page.evaluateHandle((verificationCode) => {
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const name = input.name || '';
        const placeholder = (input.placeholder || '').toLowerCase();
        const id = input.id || '';
        const type = input.type || '';

        if (name.includes('otp') || name.includes('code') || name.includes('token') ||
            placeholder.includes('code') || placeholder.includes('verification') ||
            id.includes('otp') || id.includes('code') || id.includes('verify')) {
          if (type === 'text' || type === 'number' || type === 'tel' || type === '') {
            input.value = '';
            input.focus();
            return input;
          }
        }
      }

      for (const input of inputs) {
        if (input.type === 'text' || input.type === 'number' || input.type === 'tel' || input.type === '') {
          const label = document.querySelector(`label[for="${input.id}"]`);
          if (label) {
            const labelText = label.textContent.toLowerCase();
            if (labelText.includes('code') || labelText.includes('verification') || labelText.includes('otp')) {
              input.value = '';
              input.focus();
              return input;
            }
          }
        }
      }

      return null;
    }, code);

    const inputElement = codeInput.asElement();
    await codeInput.dispose();

    if (!inputElement) {
      sessions.delete(parseInt(sessionId));
      await browser.close();
      return res.json({ success: false, error: 'Could not find verification code input on the page.' });
    }

    await randomDelay(200, 500);
    await inputElement.type(code, { delay: 80 + Math.random() * 100 });

    await randomDelay(400, 700);

    const submitBtn = await page.$('button[type="submit"], button[class*="primary"], button[class*="submit"], button[class*="verify"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await randomDelay(6000, 9000);

    const currentUrl = page.url();

    sessions.delete(parseInt(sessionId));

    if (currentUrl.includes('web.snapchat.com') || currentUrl.includes('/accounts/welcome') || currentUrl.includes('/accounts/home')) {
      await browser.close();
      return res.json({ success: true, message: 'Login successful! Verification code accepted.', displayName: username });
    }

    if (!currentUrl.includes('login')) {
      await browser.close();
      return res.json({ success: true, message: 'Login appears successful!', displayName: username });
    }

    const otpStillThere = await isOtpPage(page);
    if (otpStillThere.hasCodeInput || otpStillThere.hasOtpInput) {
      const newSessionId = ++sessionCounter;
      sessions.set(newSessionId, { browser, page, username });

      setTimeout(() => {
        const s = sessions.get(newSessionId);
        if (s) {
          sessions.delete(newSessionId);
          s.browser.close().catch(() => {});
        }
      }, 300000);

      return res.json({
        success: false,
        needsVerification: true,
        sessionId: newSessionId,
        error: 'Invalid or expired code. Please try again with the correct code.',
      });
    }

    const errorText = await getLoginError(page);
    await browser.close();

    if (errorText) {
      return res.json({ success: false, error: errorText });
    }

    return res.json({ success: false, error: 'Verification failed. The code may be incorrect or expired.' });

  } catch (err) {
    sessions.delete(parseInt(sessionId));
    await session.browser.close().catch(() => {});
    return res.json({ success: false, error: err.message || 'Error during verification' });
  }
});

export function startServer(port) {
  app.listen(port, () => {
    console.log(`Snapchat Selfbot running on http://localhost:${port}`);
  });
}
