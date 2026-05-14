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

async function randomDelay(min, max) {
  await delay(min + Math.random() * (max - min));
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
      '--window-size=390,844',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

async function humanizePage(page) {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = undefined;
    Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.' });
  });
}

async function acceptCookies(page) {
  try {
    await randomDelay(500, 1000);
    const accepted = await page.evaluate(() => {
      const texts = ['accept', 'accept all', 'allow all', 'agree', 'ok', 'i accept', 'got it', 'allow', 'continue', 'consent'];
      const btns = document.querySelectorAll('button, a, [role="button"]');
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase().trim();
        for (const t of texts) {
          if (text === t || text.includes(t)) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    if (accepted) await randomDelay(800, 1500);
  } catch {}
}

async function clickVisibleButton(page, keywords) {
  return page.evaluate((kw) => {
    const btns = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
    for (const btn of btns) {
      const text = (btn.textContent || btn.value || '').toLowerCase().trim();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      for (const word of kw) {
        if (text === word || text.includes(word) || ariaLabel.includes(word)) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return text;
          }
        }
      }
    }
    return null;
  }, keywords);
}

async function findAndType(page, value, fieldType) {
  await delay(500);

  const result = await page.evaluate((ft) => {
    const allInputs = Array.from(document.querySelectorAll('input, textarea'));
    const visibleInputs = allInputs.filter(el => el.offsetParent !== null);

    const buildSelector = (input) => {
      if (input.id) return `#${input.id}`;
      if (input.name) return `input[name="${input.name}"]`;
      if (input.placeholder) return `input[placeholder="${input.placeholder}"]`;
      return `input[type="${input.type || 'text'}"]`;
    };

    for (const input of visibleInputs) {
      const type = (input.type || '').toLowerCase();
      if (type === 'hidden' || type === 'submit') continue;

      if (ft === 'password' && type === 'password') {
        return { sel: buildSelector(input), ok: true };
      }

      if (ft === 'code' && type !== 'password' && (type === 'text' || type === 'number' || type === 'tel' || type === '')) {
        return { sel: buildSelector(input), ok: true };
      }

      if (ft === 'username') {
        if (type === 'password') continue;
        const name = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        const placeholder = (input.placeholder || '').toLowerCase();
        const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();

        if (name.includes('identifier') || name.includes('username') || name.includes('email') || name.includes('account') ||
            name.includes('text') || name.includes('phone') ||
            id.includes('username') || id.includes('email') || id.includes('account') || id.includes('identifier') ||
            placeholder.includes('username') || placeholder.includes('email') || placeholder.includes('phone') ||
            ariaLabel.includes('username') || ariaLabel.includes('email') || ariaLabel.includes('phone')) {
          return { sel: buildSelector(input), ok: true };
        }
      }
    }

    if (ft === 'username') {
      const first = visibleInputs.find(i => {
        const t = (i.type || '').toLowerCase();
        return t !== 'hidden' && t !== 'submit' && t !== 'password' && t !== 'checkbox' && t !== 'radio' && t !== 'file';
      });
      if (first) return { sel: buildSelector(first), ok: true };
    }

    if (ft === 'password') {
      const pw = visibleInputs.find(i => i.type === 'password');
      if (pw) return { sel: buildSelector(pw), ok: true };
    }

    if (ft === 'code') {
      const code = visibleInputs.find(i => {
        const t = (i.type || '').toLowerCase();
        return t !== 'hidden' && t !== 'submit' && t !== 'password';
      });
      if (code) return { sel: buildSelector(code), ok: true };
    }

    return { sel: null, ok: false };
  }, fieldType);

  if (!result.ok || !result.sel) return false;

  try {
    await page.waitForSelector(result.sel, { visible: true, timeout: 3000 });
  } catch {
    return false;
  }

  await page.click(result.sel, { clickCount: 3 });
  await delay(200);
  await page.type(result.sel, value, { delay: 40 + Math.random() * 80 });
  return true;
}

async function isOnPasswordPage(page) {
  const check = await page.evaluate(() => {
    const pwInputs = document.querySelectorAll('input[type="password"]');
    if (pwInputs.length === 0) return false;
    const text = document.body.innerText.toLowerCase();
    return text.includes('password') || text.includes('pass');
  });
  return check;
}

async function isOtpPage(page) {
  return page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    const hasCodeInput = Array.from(document.querySelectorAll('input')).some(input => {
      const type = input.type || '';
      const name = input.name || '';
      const id = input.id || '';
      const placeholder = (input.placeholder || '').toLowerCase();
      return (name.includes('code') || name.includes('otp') || name.includes('token') || name.includes('verification') ||
              id.includes('code') || id.includes('otp') || id.includes('token') || id.includes('verification') ||
              placeholder.includes('code') || placeholder.includes('verification') || placeholder.includes('digit')) &&
             (type !== 'hidden' && type !== 'submit' && type !== 'password');
    });

    const hasOtpText = text.includes('verification code') || text.includes('two-factor') ||
                       text.includes('2fa') || text.includes('authenticate') ||
                       text.includes('security code') || text.includes('enter code') ||
                       text.includes('confirm your identity') || text.includes('protect your account');

    return hasCodeInput || hasOtpText;
  });
}

async function getLoginError(page) {
  return page.evaluate(() => {
    const selectors = ['.error-msg', '.alert-danger', '[data-testid="error-message"]', '.form-error', '.notification-error', '.error-text', '.login-error', '[role="alert"]', '.text-error'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    const text = document.body.innerText.toLowerCase();
    if (text.includes('temporarily disabled')) return 'Access temporarily disabled. Try again later.';
    if (text.includes('incorrect password')) return 'Incorrect username or password';
    if (text.includes('account locked')) return 'Account is locked';
    if (text.includes('account suspended')) return 'Account is suspended';
    if (text.includes('rate limited') || text.includes('too many attempts') || text.includes('unusual activity')) return 'Too many attempts. Try again later.';
    if (text.includes('invalid username') || text.includes('invalid email')) return 'Invalid username or email';
    if (text.includes('wrong password')) return 'Wrong password';
    if (text.includes('user not found')) return 'User not found';
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

    await page.goto('https://accounts.snapchat.com/accounts/v2/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await delay(5000);
    await acceptCookies(page);

    const rateLimited = await page.evaluate(() => {
      return document.body.innerText.toLowerCase().includes('temporarily disabled') ||
             document.body.innerText.toLowerCase().includes('rate limit') ||
             document.body.innerText.toLowerCase().includes('unusual activity');
    });

    if (rateLimited) {
      await browser.close();
      return res.json({ success: false, error: 'Snapchat is rate limiting this IP. Try again in a few minutes or use a different network.' });
    }

    await delay(2000);

    let typedUsername = await findAndType(page, username, 'username');

    if (!typedUsername) {
      await delay(3000);
      typedUsername = await findAndType(page, username, 'username');
    }

    if (!typedUsername) {
      await browser.close();
      return res.json({ success: false, error: 'Could not find username input on the page.' });
    }

    await delay(800);

    let clickedNext = await clickVisibleButton(page, ['next', 'continue', 'arrow_forward']);
    if (!clickedNext) {
      await page.keyboard.press('Enter');
    }

    await delay(6000);

    const currentUrl = page.url();

    if (currentUrl.includes('web.snapchat.com') || currentUrl.includes('/accounts/welcome') || currentUrl.includes('/accounts/home')) {
      await browser.close();
      return res.json({ success: true, message: 'Login successful!', displayName: username });
    }

    const rateLimited2 = await page.evaluate(() => {
      return document.body.innerText.toLowerCase().includes('temporarily disabled') ||
             document.body.innerText.toLowerCase().includes('rate limit');
    });

    if (rateLimited2) {
      await browser.close();
      return res.json({ success: false, error: 'Rate limited after username. Try again later.' });
    }

    const onPasswordPage = await isOnPasswordPage(page);

    if (!onPasswordPage && !currentUrl.includes('login') && !currentUrl.includes('accounts')) {
      await browser.close();
      return res.json({ success: true, message: 'Login successful!', displayName: username });
    }

    if (!onPasswordPage) {
      const errorText = await getLoginError(page);
      await browser.close();
      return res.json({ success: false, error: errorText || 'Login failed after username step.' });
    }

    await acceptCookies(page);

    const typedPassword = await findAndType(page, password, 'password');
    if (!typedPassword) {
      await browser.close();
      return res.json({ success: false, error: 'Could not find password input.' });
    }

    await delay(800);

    let clickedLogin = await clickVisibleButton(page, ['log in', 'login', 'sign in', 'submit', 'continue']);
    if (!clickedLogin) {
      await page.keyboard.press('Enter');
    }

    await delay(8000);

    const finalUrl = page.url();

    if (finalUrl.includes('web.snapchat.com') || finalUrl.includes('/accounts/welcome') || finalUrl.includes('/accounts/home')) {
      await browser.close();
      return res.json({ success: true, message: 'Login successful!', displayName: username });
    }

    if (!finalUrl.includes('login') && !finalUrl.includes('accounts')) {
      await browser.close();
      return res.json({ success: true, message: 'Login successful!', displayName: username });
    }

    const otpDetected = await isOtpPage(page);

    if (otpDetected) {
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

    const errorText = await getLoginError(page);
    await browser.close();
    return res.json({ success: false, error: errorText || 'Login failed.' });

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
    return res.json({ success: false, error: 'Session expired. Please login again.' });
  }

  try {
    const { browser, page, username } = session;

    const typedCode = await findAndType(page, code, 'code');
    if (!typedCode) {
      const codeSelector = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input:not([type])');
        for (const input of inputs) {
          if (input.type !== 'hidden' && input.type !== 'submit' && input.type !== 'password') {
            return input.id ? `#${input.id}` : `input[type="${input.type || 'text'}"]`;
          }
        }
        return null;
      });

      if (!codeSelector) {
        sessions.delete(parseInt(sessionId));
        await browser.close();
        return res.json({ success: false, error: 'Could not find verification code input.' });
      }

      await page.click(codeSelector, { clickCount: 3 });
      await randomDelay(100, 300);
      await page.type(codeSelector, code, { delay: 80 + Math.random() * 100 });
    }

    await randomDelay(400, 700);

    const clickedSubmit = await clickVisibleButton(page, ['submit', 'verify', 'continue', 'next', 'confirm', 'done', 'log in', 'login', 'go']);
    if (!clickedSubmit) {
      await page.keyboard.press('Enter');
    }

    await randomDelay(7000, 10000);

    const currentUrl = page.url();

    sessions.delete(parseInt(sessionId));

    if (currentUrl.includes('web.snapchat.com') || currentUrl.includes('/accounts/welcome') || currentUrl.includes('/accounts/home')) {
      await browser.close();
      return res.json({ success: true, message: 'Login successful! Code accepted.', displayName: username });
    }

    if (!currentUrl.includes('login') && !currentUrl.includes('accounts')) {
      await browser.close();
      return res.json({ success: true, message: 'Login appears successful!', displayName: username });
    }

    const otpStillThere = await isOtpPage(page);
    if (otpStillThere) {
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
        error: 'Invalid or expired code. Try again.',
      });
    }

    const errorText = await getLoginError(page);
    await browser.close();
    return res.json({ success: false, error: errorText || 'Verification failed. Code may be incorrect.' });

  } catch (err) {
    sessions.delete(parseInt(sessionId));
    await session.browser.close().catch(() => {});
    return res.json({ success: false, error: err.message || 'Error during verification' });
  }
});

app.post('/api/debug', async (req, res) => {
  const { username, password } = req.body;
  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    await humanizePage(page);

    await page.goto('https://accounts.snapchat.com/v2/login', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await randomDelay(4000, 6000);
    await acceptCookies(page);
    await randomDelay(1000, 2000);

    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    const pageInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, button')).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        className: el.className || '',
        placeholder: el.placeholder || '',
        text: el.textContent.trim().substring(0, 50),
        visible: el.getBoundingClientRect().width > 0,
      }));
      return {
        url: location.href,
        title: document.title,
        inputs: inputs,
      };
    });

    await browser.close();
    res.json({ success: true, screenshot, pageInfo });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.json({ success: false, error: err.message });
  }
});

export function startServer(port) {
  app.listen(port, () => {
    console.log(`Snapchat Selfbot running on http://localhost:${port}`);
  });
}
