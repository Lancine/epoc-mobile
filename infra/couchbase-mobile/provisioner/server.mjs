import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '256kb' }));

const corsOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : '*',
    credentials: true,
  }),
);

const PORT = Number(process.env.PORT || 8088);

// Sync Gateway admin URL (internal)
const SG_ADMIN_URL = process.env.SG_ADMIN_URL || 'http://sync-gateway:4985';
const SG_DB = process.env.SG_DB || 'epoc-learning';

// Optional learnerKey salt (same as VITE_CBL_LEARNER_KEY_SALT)
const LEARNER_KEY_SALT = (process.env.LEARNER_KEY_SALT || '').trim();

const PASSWORD_LENGTH = Math.max(16, Number(process.env.PASSWORD_LENGTH || 24));

function sanitizeIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .slice(0, 120);
}

function sha256Base64Url(input) {
  const hash = crypto.createHash('sha256').update(input, 'utf8').digest('base64');
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function deriveLearnerKey(learnerId, learnerKeyFromClient) {
  if (learnerKeyFromClient) return sanitizeIdPart(learnerKeyFromClient);
  if (!learnerId) return 'anonymous';
  if (LEARNER_KEY_SALT) {
    const full = sha256Base64Url(`${LEARNER_KEY_SALT}::${learnerId}`);
    return full.slice(0, 32);
  }
  return sanitizeIdPart(learnerId);
}

function randomPassword(len = PASSWORD_LENGTH) {
  // hex is 2 chars per byte
  const bytes = Math.ceil(len / 2);
  return crypto.randomBytes(bytes).toString('hex').slice(0, len);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /register
 * Body: { learnerId: string, learnerKey?: string }
 * Response: { learnerId, learnerKey, username, password, channel }
 */
app.post('/register', async (req, res) => {
  try {
    const learnerId = String(req.body?.learnerId || '').trim();
    const learnerKeyFromClient = String(req.body?.learnerKey || '').trim();

    if (!learnerId) {
      return res.status(400).json({ error: 'learnerId is required' });
    }

    const learnerKey = deriveLearnerKey(learnerId, learnerKeyFromClient);

    const username = learnerKey;
    const password = randomPassword();

    const userUrl = `${SG_ADMIN_URL.replace(/\/+$/g, '')}/${encodeURIComponent(SG_DB)}/_user/${encodeURIComponent(
      username,
    )}`;

    const payload = {
      name: username,
      password,
      admin_channels: [`u::${learnerKey}`],
    };

    const sgRes = await fetch(userUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!sgRes.ok) {
      const text = await sgRes.text();
      return res.status(502).json({ error: 'sync-gateway error', status: sgRes.status, detail: text });
    }

    return res.json({
      learnerId,
      learnerKey,
      username,
      password,
      channel: `u::${learnerKey}`,
    });
  } catch (e) {
    return res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[provisioner] listening on :${PORT}`);
});
