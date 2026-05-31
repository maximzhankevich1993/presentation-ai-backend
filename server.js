const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '10mb' }));
app.use(helmet());
app.use(cors({ 
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], 
  allowedHeaders: ['Content-Type', 'Authorization'] 
}));

// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════
const pool = process.env.DATABASE_URL 
  ? new Pool({ 
      connectionString: process.env.DATABASE_URL, 
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

// ═══════════════════════════════════════════════════════════════
// КЭШ И СЧЁТЧИКИ
// ═══════════════════════════════════════════════════════════════
const generationCache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

const guestGenerationCounter = new Map();

setInterval(() => {
  guestGenerationCounter.clear();
  console.log('🔄 Очищен счётчик гостей');
}, 24 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// YANDEX GPT
// ═══════════════════════════════════════════════════════════
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

// ═══════════════════════════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════════════════════
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'apikey',
    pass: process.env.SMTP_PASS || ''
  }
});
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@presentation-ai.com';

if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
  console.error('❌ YANDEX_API_KEY и YANDEX_FOLDER_ID обязательны');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════

async function checkAndResetMonthlyGenerations(user) {
  if (!pool || user.id === 'guest') return user;
  
  try {
    const now = new Date();
    const lastReset = user.last_reset_date ? new Date(user.last_reset_date) : null;
    
    const needReset = !lastReset || 
      now.getMonth() !== lastReset.getMonth() || 
      now.getFullYear() !== lastReset.getFullYear();
    
    if (needReset && !user.is_premium && !user.is_vip) {
      const newMonthlyLeft = 5;
      await pool.query(
        `UPDATE users 
         SET monthly_generations_left = $1, 
             last_reset_date = NOW(),
             free_generations_left = $1
         WHERE id = $2`,
        [newMonthlyLeft, user.id]
      );
      
      user.monthly_generations_left = newMonthlyLeft;
      user.free_generations_left = newMonthlyLeft;
      user.last_reset_date = now;
      console.log(`🔄 Сброс ежемесячных генераций для ${user.email} до ${newMonthlyLeft}`);
    }
  } catch (e) {
    console.error('Ошибка сброса месячного лимита:', e);
  }
  
  return user;
}

async function decrementGenerations(user) {
  if (user.id === 'guest') {
    const newCount = (user.generations_used || 0) + 1;
    guestGenerationCounter.set(user.guestId, newCount);
    user.free_generations_left = Math.max(0, 5 - newCount);
    user.generations_used = newCount;
    return user;
  }
  
  if (!pool) return user;
  
  const newLeft = Math.max(0, (user.free_generations_left || 0) - 1);
  const newMonthlyLeft = Math.max(0, (user.monthly_generations_left || 0) - 1);
  
  await pool.query(
    `UPDATE users 
     SET free_generations_left = $1, 
         monthly_generations_left = $2, 
         total_generations = total_generations + 1 
     WHERE id = $3`,
    [newLeft, newMonthlyLeft, user.id]
  );
  
  user.free_generations_left = newLeft;
  user.monthly_generations_left = newMonthlyLeft;
  
  return user;
}

async function checkBonusMonth(userId) {
  if (!pool || userId === 'guest') return false;
  
  try {
    const result = await pool.query(
      `SELECT * FROM user_bonus_months 
       WHERE user_id = $1 AND is_used = FALSE AND bonus_month = 2
       AND applied_at <= NOW()`,
      [userId]
    );
    
    if (result.rows.length > 0) {
      await pool.query(
        `UPDATE user_bonus_months SET is_used = TRUE WHERE id = $1`,
        [result.rows[0].id]
      );
      
      await pool.query(
        `UPDATE users 
         SET premium_expiry = premium_expiry + INTERVAL '1 month'
         WHERE id = $1 AND is_premium = TRUE`,
        [userId]
      );
      
      console.log(`🎁 Бонусный месяц активирован для пользователя ${userId}`);
      return true;
    }
  } catch (e) {
    console.error('Ошибка проверки бонусного месяца:', e);
  }
  
  return false;
}

async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token || !pool) {
    const guestId = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
    const usedGenerations = guestGenerationCounter.get(guestId) || 0;
    
    req.user = { 
      id: 'guest', 
      email: 'guest@demo.com', 
      name: 'Гость', 
      is_premium: false, 
      free_generations_left: Math.max(0, 5 - usedGenerations),
      monthly_generations_left: Math.max(0, 5 - usedGenerations),
      generations_used: usedGenerations,
      is_vip: false,
      guestId: guestId,
      last_reset_date: null
    };
    return next();
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.is_premium, u.premium_expiry, 
              u.free_generations_left, u.monthly_generations_left, u.last_reset_date, u.is_vip
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length > 0) {
      req.user = result.rows[0];
      req.user = await checkAndResetMonthlyGenerations(req.user);
    } else {
      const guestId = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
      const usedGenerations = guestGenerationCounter.get(guestId) || 0;
      req.user = { 
        id: 'guest', 
        email: 'guest@demo.com', 
        name: 'Гость', 
        is_premium: false, 
        free_generations_left: Math.max(0, 5 - usedGenerations),
        monthly_generations_left: Math.max(0, 5 - usedGenerations),
        generations_used: usedGenerations,
        is_vip: false,
        guestId: guestId,
        last_reset_date: null
      };
    }
    next();
  } catch (e) {
    const guestId = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
    const usedGenerations = guestGenerationCounter.get(guestId) || 0;
    req.user = { 
      id: 'guest', 
      email: 'guest@demo.com', 
      name: 'Гость', 
      is_premium: false, 
      free_generations_left: Math.max(0, 5 - usedGenerations),
      monthly_generations_left: Math.max(0, 5 - usedGenerations),
      generations_used: usedGenerations,
      is_vip: false,
      guestId: guestId,
      last_reset_date: null
    };
    next();
  }
}

function getStandardName(code) {
  const standards = {
    'common_core': 'Common Core (USA)',
    'cambridge': 'Cambridge International',
    'ib': 'International Baccalaureate (IB)',
    'fgos': 'ФГОС (Россия)',
    'national_uk': 'National Curriculum (UK)',
    'australian': 'Australian Curriculum',
    'cbse': 'CBSE (India)',
    'common_eu': 'European Framework'
  };
  return standards[code] || code;
}

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    version: '8.4.0', 
    api: 'YandexGPT',
    db: !!pool,
    uptime: process.uptime()
  });
});

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  if (!pool) {
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: req.body.name || 'Demo', isPremium: false, freeGenerationsLeft: 5, monthlyGenerationsLeft: 5 } });
  }

  try {
    const { email, password, name, referralCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email уже используется' });

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, verification_token, free_generations_left, monthly_generations_left, last_reset_date)
       VALUES ($1, $2, $3, $4, 5, 5, NOW()) RETURNING id, email, name`,
      [email.toLowerCase(), passwordHash, name || email.split('@')[0], verificationToken]
    );

    const user = result.rows[0];
    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    if (referralCode) {
      try {
        const referrer = await pool.query(
          'SELECT user_id FROM referrals WHERE code = $1',
          [referralCode.toUpperCase()]
        );
        
        if (referrer.rows.length > 0) {
          const referrerId = referrer.rows[0].user_id;
          if (referrerId !== user.id) {
            await pool.query(
              `INSERT INTO referred_friends (referrer_id, friend_id, status, reward, created_at)
               VALUES ($1, $2, 'activated', 2, NOW())`,
              [referrerId, user.id]
            );
            
            await pool.query(
              `UPDATE referrals 
               SET referrals_count = referrals_count + 1,
                   bonus_generations = bonus_generations + 2
               WHERE user_id = $1`,
              [referrerId]
            );
            
            await pool.query(
              `UPDATE users 
               SET free_generations_left = free_generations_left + 2,
                   monthly_generations_left = monthly_generations_left + 2
               WHERE id = $1`,
              [referrerId]
            );
          }
        }
      } catch (e) {
        console.log('Referral apply error:', e);
      }
    }

    setTimeout(() => {
      transporter.sendMail({
        from: `"Презентатор ИИ" <${FROM_EMAIL}>`,
        to: email,
        subject: 'Добро пожаловать! 🎉',
        html: `<h2>Добро пожаловать, ${user.name}!</h2><p>🎁 5 бесплатных генераций каждый месяц.</p>`
      }).catch(console.log);
    }, 0);

    res.json({ token: sessionToken, user: { id: user.id, email: user.email, name: user.name, isPremium: false, freeGenerationsLeft: 5, monthlyGenerationsLeft: 5 } });
  } catch (e) {
    console.error('Register:', e);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!pool) {
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: 'Demo', isPremium: true, freeGenerationsLeft: 999, monthlyGenerationsLeft: 999, isVip: true } });
  }

  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    const result = await pool.query(
      `SELECT id, email, name, password_hash, is_premium, premium_expiry, 
              free_generations_left, monthly_generations_left, last_reset_date, 
              failed_login_attempts, locked_until, is_vip 
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    let user = result.rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Аккаунт заблокирован' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await pool.query(
        'UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1',
        [user.id]
      );
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    user = await checkAndResetMonthlyGenerations(user);

    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );

    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    
    try {
      await pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [user.id, tokenHash]
      );
    } catch (err) {
      console.log('Sessions table error:', err.message);
    }

    res.json({
      token: sessionToken,
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        isPremium: user.is_premium || false, 
        premiumExpiry: user.premium_expiry, 
        freeGenerationsLeft: user.free_generations_left || 5,
        monthlyGenerationsLeft: user.monthly_generations_left || 5,
        isVip: user.is_vip || false
      }
    });
  } catch (e) {
    console.error('❌ Login error:', e);
    res.status(500).json({ error: 'Ошибка входа: ' + e.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  if (!pool) return res.json({ success: true });
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    }
    res.json({ success: true });
  } catch (_) {
    res.json({ success: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// USER PROFILE
// ═══════════════════════════════════════════════════════════════
app.get('/api/profile', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    
    if (user.id === 'guest') {
      return res.json({
        id: 'guest',
        email: 'guest@demo.com',
        name: 'Guest',
        isPremium: false,
        isVip: false,
        freeGenerationsLeft: user.free_generations_left,
        monthlyGenerationsLeft: user.monthly_generations_left
      });
    }
    
    if (!pool) {
      return res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: user.is_premium || false,
        isVip: user.is_vip || false,
        freeGenerationsLeft: user.free_generations_left || 5,
        monthlyGenerationsLeft: user.monthly_generations_left || 5
      });
    }
    
    const result = await pool.query(
      `SELECT id, email, name, is_premium, is_vip, 
              free_generations_left, monthly_generations_left, premium_expiry
       FROM users WHERE id = $1`,
      [user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const dbUser = result.rows[0];
    
    const bonusResult = await pool.query(
      `SELECT * FROM user_bonus_months 
       WHERE user_id = $1 AND is_used = FALSE AND bonus_month = 2`,
      [user.id]
    );
    
    res.json({
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      isPremium: dbUser.is_premium || false,
      isVip: dbUser.is_vip || false,
      freeGenerationsLeft: dbUser.free_generations_left || 5,
      monthlyGenerationsLeft: dbUser.monthly_generations_left || 5,
      premiumExpiry: dbUser.premium_expiry,
      hasBonusMonth: bonusResult.rows.length > 0
    });
    
  } catch (e) {
    console.error('❌ Profile error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROMOCODES
// ═══════════════════════════════════════════════════════════════

app.post('/api/promocode/validate', optionalAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const user = req.user;
    
    if (!code) {
      return res.status(400).json({ valid: false, message: 'Code required' });
    }
    
    if (!pool) {
      return res.json({ valid: true, discountType: 'percent', discountValue: 100, description: 'DEMO: 100% off' });
    }
    
    const result = await pool.query(
      `SELECT * FROM promocodes 
       WHERE code = $1 
       AND is_active = true 
       AND (valid_until IS NULL OR valid_until > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)`,
      [code.toUpperCase()]
    );
    
    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO promocode_analytics (promocode_id, action, user_id, created_at)
         VALUES (NULL, 'invalid_attempt', $1, NOW())`,
        [user.id !== 'guest' ? user.id : null]
      );
      return res.status(404).json({ valid: false, message: 'Invalid or expired promo code' });
    }
    
    const promocode = result.rows[0];
    
    if (user.id !== 'guest') {
      const usageCheck = await pool.query(
        `SELECT * FROM promocode_usages WHERE promocode_id = $1 AND user_id = $2`,
        [promocode.id, user.id]
      );
      
      if (usageCheck.rows.length > 0) {
        await pool.query(
          `INSERT INTO promocode_analytics (promocode_id, action, user_id, created_at)
           VALUES ($1, 'already_used', $2, NOW())`,
          [promocode.id, user.id]
        );
        return res.status(400).json({ valid: false, message: 'You have already used this promo code' });
      }
    }
    
    await pool.query(
      `INSERT INTO promocode_analytics (promocode_id, action, user_id, created_at)
       VALUES ($1, 'validate', $2, NOW())`,
      [promocode.id, user.id !== 'guest' ? user.id : null]
    );
    
    res.json({
      valid: true,
      discountType: promocode.discount_type,
      discountValue: promocode.discount_value,
      description: promocode.description,
      promoId: promocode.id
    });
    
  } catch (e) {
    console.error('❌ Promocode validate error:', e.message);
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

app.post('/api/promocode/apply', optionalAuth, async (req, res) => {
  try {
    const { code, plan } = req.body;
    const user = req.user;
    
    if (!code || !plan) {
      return res.status(400).json({ success: false, message: 'Code and plan required' });
    }
    
    if (!pool) {
      const prices = { monthly: 4.99, half_year: 29.99, year: 49.99 };
      const originalPrice = prices[plan] || 4.99;
      return res.json({ success: true, finalPrice: originalPrice * 0.5, discountApplied: true, message: '50% off applied!' });
    }
    
    const result = await pool.query(
      `SELECT * FROM promocodes 
       WHERE code = $1 AND is_active = true 
       AND (valid_until IS NULL OR valid_until > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)`,
      [code.toUpperCase()]
    );
    
    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO promocode_analytics (promocode_id, action, user_id, created_at)
         VALUES (NULL, 'apply_failed', $1, NOW())`,
        [user.id !== 'guest' ? user.id : null]
      );
      return res.status(404).json({ success: false, message: 'Invalid or expired promo code' });
    }
    
    const promocode = result.rows[0];
    
    if (user.id !== 'guest') {
      const usageCheck = await pool.query(
        `SELECT * FROM promocode_usages WHERE promocode_id = $1 AND user_id = $2`,
        [promocode.id, user.id]
      );
      
      if (usageCheck.rows.length > 0) {
        await pool.query(
          `INSERT INTO promocode_analytics (promocode_id, action, user_id, created_at)
           VALUES ($1, 'already_used', $2, NOW())`,
          [promocode.id, user.id]
        );
        return res.status(400).json({ success: false, message: 'You have already used this promo code' });
      }
    }
    
    const prices = { monthly: 4.99, half_year: 29.99, year: 49.99 };
    let originalPrice = prices[plan] || 4.99;
    let finalPrice = originalPrice;
    let discountApplied = false;
    
    if (promocode.discount_type === 'percent') {
      finalPrice = originalPrice * (1 - promocode.discount_value / 100);
      discountApplied = true;
    } else if (promocode.discount_type === 'free_month') {
      finalPrice = originalPrice;
      discountApplied = true;
    }
    
    await pool.query(
      `INSERT INTO promocode_usages (promocode_id, user_id) VALUES ($1, $2)`,
      [promocode.id, user.id]
    );
    
    await pool.query(
      `UPDATE promocodes SET used_count = used_count + 1 WHERE id = $1`,
      [promocode.id]
    );
    
    if (promocode.discount_type === 'free_month' && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO user_bonus_months (user_id, bonus_month, applied_at, promocode_id, is_used)
         VALUES ($1, $2, NOW(), $3, FALSE)`,
        [user.id, 2, promocode.id]
      );
    }
    
    await pool.query(
      `INSERT INTO promocode_analytics (promocode_id, action, user_id, created_at)
       VALUES ($1, 'apply_success', $2, NOW())`,
      [promocode.id, user.id]
    );
    
    res.json({
      success: true,
      finalPrice: finalPrice,
      discountApplied: discountApplied,
      discountType: promocode.discount_type,
      discountValue: promocode.discount_value,
      message: `Promo code applied! ${promocode.discount_type === 'percent' ? `You save ${promocode.discount_value}%` : 'You get second month free'}`
    });
    
  } catch (e) {
    console.error('❌ Promocode apply error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GENERATE (ПРЕЗЕНТАЦИИ)
// ═══════════════════════════════════════════════════════════════
app.post('/api/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, slideCount, maxSlides } = req.body;
    const slidesCount = slideCount || maxSlides || 5;
    
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    let user = req.user;

    if (user.free_generations_left <= 0) {
      return res.status(402).json({ 
        error: 'Бесплатные генерации закончились',
        needPayment: true,
        message: 'У вас закончились бесплатные генерации на этот месяц. Оформите подписку, чтобы продолжить.'
      });
    }

    if (!user.is_premium && !user.is_vip && slidesCount > 10) {
      return res.status(402).json({ 
        error: 'Бесплатные презентации ограничены 10 слайдами',
        needPayment: true,
        message: 'В бесплатной версии максимум 10 слайдов. Оформите подписку для создания более объёмных презентаций.'
      });
    }

    const cacheKey = `${topic.toLowerCase()}_${slidesCount}`;
    
    if (generationCache.has(cacheKey)) {
      const cached = generationCache.get(cacheKey);
      user = await decrementGenerations(user);
      return res.json(cached);
    }

    const prompt = `Ты — эксперт по созданию презентаций. Создай структуру презентации на тему: "${topic}". Количество слайдов: ${slidesCount}.

ПРАВИЛА:
- Каждый слайд: ЗАГОЛОВОК (5-8 слов) + 4-6 пунктов
- Длина КАЖДОГО пункта: 45-60 слов
- Используй: цифры, проценты, даты, статистику, примеры из реальной жизни

Верни ТОЛЬКО JSON в формате:
{
  "title": "Название презентации",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["пункт 1", "пункт 2", "пункт 3", "пункт 4"]
    }
  ]
}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "8000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 120000 
    });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    
    let presentation = JSON.parse(cleanText);
    
    if (!presentation.slides || presentation.slides.length === 0) {
      presentation.slides = [];
    }
    
    if (presentation.slides.length > slidesCount) {
      console.log(`⚠️ AI сгенерировал ${presentation.slides.length} слайдов, обрезаем до ${slidesCount}`);
      presentation.slides = presentation.slides.slice(0, slidesCount);
    }
    
    while (presentation.slides.length < slidesCount) {
      presentation.slides.push({
        title: `Слайд ${presentation.slides.length + 1}`,
        content: [
          `Ключевой аспект темы "${topic}" требует детального рассмотрения.`,
          `Анализ показывает важность этого направления для развития.`,
          `Практические примеры подтверждают эффективность данного подхода.`,
          `Рекомендации для дальнейшего изучения и внедрения.`
        ]
      });
    }
    
    generationCache.set(cacheKey, presentation);
    setTimeout(() => generationCache.delete(cacheKey), CACHE_TTL);

    user = await decrementGenerations(user);
    
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO generation_history (user_id, type, title, slide_count, created_at)
         VALUES ($1, 'presentation', $2, $3, NOW())`,
        [user.id, topic, slidesCount]
      );
    }
    
    res.json(presentation);
    
  } catch (e) {
    console.error('❌ Generation error:', e.message);
    
    const slidesCount = req.body.slideCount || req.body.maxSlides || 5;
    const slides = [];
    for (let i = 0; i < slidesCount; i++) {
      slides.push({
        title: i === 0 ? `Введение в тему "${req.body.topic}"` : i === slidesCount - 1 ? 'Заключение' : `Аспект ${i + 1}`,
        content: [
          `Ключевой момент темы "${req.body.topic}" требует внимательного анализа.`,
          `Анализ показывает важность этого направления для развития.`,
          `Практические примеры подтверждают эффективность данного подхода.`,
          `Рекомендации для дальнейшего изучения и внедрения.`
        ]
      });
    }
    res.json({ title: req.body.topic, slides });
  }
});

// ═══════════════════════════════════════════════════════════════
// LESSON PLAN GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/lesson-plan/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, subject, standard, grade, durationMinutes = 45, slideCount = 5 } = req.body;
    
    if (!topic || !subject || !grade) {
      return res.status(400).json({ error: 'Тема, предмет и класс обязательны' });
    }

    let user = req.user;
    let slidesCount = Math.min(Math.max(slideCount, 3), 10);
    
    if (!user.is_premium && !user.is_vip && slidesCount > 10) {
      return res.status(402).json({ 
        error: 'Бесплатные уроки ограничены 10 слайдами',
        needPayment: true,
        message: 'В бесплатной версии максимум 10 слайдов. Оформите подписку для создания более подробных уроков.'
      });
    }

    if (user.free_generations_left <= 0) {
      return res.status(402).json({ 
        error: 'Бесплатные генерации закончились',
        needPayment: true,
        message: 'У вас закончились бесплатные генерации на этот месяц. Оформите подписку, чтобы продолжить.'
      });
    }

    const prompt = `Ты — опытный учитель по предмету "${subject}" для ${grade} класса. Создай полноценный урок на тему "${topic}" в виде презентации на ${slidesCount} слайдов.

ТРЕБОВАНИЯ:
- Каждый слайд — это отдельная часть урока
- Содержание должно быть информативным, понятным для учеников ${grade} класса
- Используй: определения, примеры, факты, вопросы для учеников
- Добавляй конкретные знания по теме "${topic}" и предмету "${subject}"

Верни ТОЛЬКО JSON в формате:
{
  "topic": "${topic}",
  "subject": "${subject}",
  "grade": "${grade}",
  "slides": [
    {
      "title": "Заголовок слайда (5-10 слов)",
      "content": [
        "Ключевой факт или определение (20-35 слов)",
        "Дополнительная информация с примером (20-35 слов)",
        "Вопрос к ученикам или задание (15-25 слов)",
        "Вывод или запоминающийся факт (15-25 слов)"
      ]
    }
  ],
  "homework": "Домашнее задание (30-60 слов с конкретными заданиями)",
  "materials": ["Материал или ресурс 1", "Материал или ресурс 2", "Материал или ресурс 3"]
}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "8000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 90000 
    });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    
    let lessonData = JSON.parse(cleanText);
    
    if (!lessonData.slides || lessonData.slides.length === 0) {
      lessonData.slides = [];
    }
    
    console.log(`📚 AI сгенерировал ${lessonData.slides.length} слайдов урока`);

    user = await decrementGenerations(user);
    
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO generation_history (user_id, type, title, slide_count, created_at)
         VALUES ($1, 'lesson', $2, $3, NOW())`,
        [user.id, topic, slidesCount]
      );
    }
    
    console.log(`✅ Урок создан: "${topic}" (${lessonData.slides.length} слайдов)`);
    res.json(lessonData);
    
  } catch (e) {
    console.error('❌ Lesson Plan error:', e.message);
    res.status(500).json({ error: 'Ошибка генерации плана урока' });
  }
});

// ═══════════════════════════════════════════════════════════════
// QUIZ GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/quiz/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, questionCount = 5 } = req.body;
    
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });
    
    let user = req.user;
    const qCount = Math.min(Math.max(questionCount, 3), 10);

    if (user.free_generations_left <= 0) {
      return res.status(402).json({ 
        error: 'Бесплатные генерации закончились',
        needPayment: true,
        message: 'У вас закончились бесплатные генерации на этот месяц. Оформите подписку, чтобы продолжить.'
      });
    }

    const prompt = `Ты — опытный преподаватель. Создай тест из ${qCount} вопросов по теме "${topic}".

ТРЕБОВАНИЯ:
- Каждый вопрос должен быть конкретным и проверять знания по теме
- 4 варианта ответа (А, Б, В, Г), только один правильный
- Правильный ответ должен быть реалистичным
- Добавь краткое пояснение к каждому вопросу

Верни ТОЛЬКО JSON в формате:
{
  "questions": [
    {
      "question": "Конкретный вопрос по теме?",
      "options": ["Правильный ответ", "Неверный вариант 1", "Неверный вариант 2", "Неверный вариант 3"],
      "correct": 0,
      "explanation": "Краткое пояснение правильного ответа"
    }
  ],
  "difficulty": "medium",
  "timeLimitMinutes": ${qCount * 2}
}`;

    try {
      const response = await axios.post(YANDEX_URL, {
        modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
        completionOptions: { stream: false, temperature: 0.7, maxTokens: "4000" },
        messages: [{ role: 'user', text: prompt }]
      }, { 
        headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
        timeout: 60000 
      });

      let text = response.data.result.alternatives[0].message.text;
      let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleanText = jsonMatch[0];
      
      let quizData = JSON.parse(cleanText);
      
      if (quizData.questions && quizData.questions.length > qCount) {
        console.log(`⚠️ AI сгенерировал ${quizData.questions.length} вопросов, обрезаем до ${qCount}`);
        quizData.questions = quizData.questions.slice(0, qCount);
      }
      
      user = await decrementGenerations(user);
      
      if (pool && user.id !== 'guest') {
        await pool.query(
          `INSERT INTO generation_history (user_id, type, title, slide_count, created_at)
           VALUES ($1, 'quiz', $2, $3, NOW())`,
          [user.id, topic, qCount]
        );
      }
      
      console.log(`✅ Тест создан: "${topic}" (${quizData.questions?.length || 0} вопросов)`);
      res.json(quizData);
      
    } catch (aiError) {
      console.error('❌ YandexGPT error:', aiError.message);
      
      const questions = [];
      for (let i = 0; i < qCount; i++) {
        questions.push({
          question: `Какое утверждение о теме "${topic}" является верным?`,
          options: [
            `${topic} — это важная область знаний`,
            `${topic} не имеет практического применения`,
            `${topic} изучается только в теории`,
            `Все утверждения неверны`
          ],
          correct: 0,
          explanation: `${topic} действительно является важной областью знаний с множеством практических применений.`
        });
      }
      
      user = await decrementGenerations(user);
      res.json({ questions, difficulty: 'medium', timeLimitMinutes: qCount * 2 });
    }
    
  } catch (e) {
    console.error('❌ Quiz generation error:', e.message);
    res.status(500).json({ error: 'Ошибка генерации теста' });
  }
});

app.post('/api/quiz/from-presentation', optionalAuth, async (req, res) => {
  try {
    const { title, slides, questionCount = 5 } = req.body;
    
    if (!title || !slides) {
      return res.status(400).json({ error: 'Некорректные данные' });
    }
    
    let user = req.user;
    const qCount = Math.min(Math.max(questionCount, 3), 10);

    if (user.free_generations_left <= 0) {
      return res.status(402).json({ 
        error: 'Бесплатные генерации закончились',
        needPayment: true,
        message: 'У вас закончились бесплатные генерации на этот месяц.'
      });
    }

    const slidesText = slides.map((s, i) => {
      if (typeof s === 'string') return s;
      if (s.content && Array.isArray(s.content)) return s.content.join(' ');
      if (s.title) return s.title;
      return '';
    }).join('\n').substring(0, 3000);

    const prompt = `На основе следующего содержания презентации "${title}" создай тест из ${qCount} вопросов:

СОДЕРЖАНИЕ:
${slidesText}

ТРЕБОВАНИЯ:
- Каждый вопрос должен проверять понимание материала из презентации
- 4 варианта ответа, только один правильный
- Добавь краткое пояснение

Верни ТОЛЬКО JSON в формате:
{
  "title": "${title}",
  "questions": [
    {
      "question": "Вопрос по содержанию презентации?",
      "options": ["Правильный ответ", "Неверный 1", "Неверный 2", "Неверный 3"],
      "correct": 0,
      "explanation": "Пояснение"
    }
  ]
}`;

    try {
      const response = await axios.post(YANDEX_URL, {
        modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
        completionOptions: { stream: false, temperature: 0.7, maxTokens: "4000" },
        messages: [{ role: 'user', text: prompt }]
      }, { 
        headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
        timeout: 60000 
      });

      let text = response.data.result.alternatives[0].message.text;
      let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleanText = jsonMatch[0];
      
      let quizData = JSON.parse(cleanText);
      
      if (quizData.questions && quizData.questions.length > qCount) {
        console.log(`⚠️ AI сгенерировал ${quizData.questions.length} вопросов, обрезаем до ${qCount}`);
        quizData.questions = quizData.questions.slice(0, qCount);
      }
      
      user = await decrementGenerations(user);
      
      if (pool && user.id !== 'guest') {
        await pool.query(
          `INSERT INTO generation_history (user_id, type, title, slide_count, created_at)
           VALUES ($1, 'quiz', $2, $3, NOW())`,
          [user.id, title, qCount]
        );
      }
      
      console.log(`✅ Тест из презентации создан: "${title}"`);
      res.json(quizData);
      
    } catch (aiError) {
      console.error('❌ YandexGPT error:', aiError.message);
      
      const questions = [];
      for (let i = 0; i < qCount; i++) {
        questions.push({
          question: `Какой ключевой аспект презентации "${title}" является наиболее важным?`,
          options: [
            'Понимание основной темы и её практическое применение',
            'Запоминание всех терминов без понимания сути',
            'Игнорирование примеров из презентации',
            'Только теоретическое изучение без практики'
          ],
          correct: 0,
          explanation: 'Понимание темы и её применение на практике — ключ к успешному усвоению материала презентации.'
        });
      }
      
      user = await decrementGenerations(user);
      res.json({ title, questions, difficulty: 'medium', timeLimitMinutes: qCount * 2 });
    }
    
  } catch (e) {
    console.error('❌ Quiz from presentation error:', e.message);
    res.status(500).json({ error: 'Ошибка генерации теста' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REPORT GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/report/generate', optionalAuth, async (req, res) => {
  try {
    const { company, period, standard, reportType, slideCount = 6 } = req.body;
    
    if (!company || !period) {
      return res.status(400).json({ error: 'Компания и период обязательны' });
    }

    let user = req.user;
    let slidesCount = Math.min(Math.max(slideCount, 3), 15);
    
    if (!user.is_premium && !user.is_vip && slidesCount > 10) {
      slidesCount = 10;
    }
    
    let reportTypeName = 'Финансовый отчёт';
    if (reportType === 'annual') reportTypeName = 'Годовой отчёт';
    else if (reportType === 'esg') reportTypeName = 'ESG отчёт';
    else if (reportType === 'management') reportTypeName = 'Управленческий отчёт';
    
    let standardName = standard.toUpperCase();
    if (standard === 'ifrs') standardName = 'IFRS';
    else if (standard === 'gaap') standardName = 'US GAAP';
    else if (standard === 'rsbu') standardName = 'РСБУ';
    else if (standard === 'gri') standardName = 'GRI';

    if (user.free_generations_left <= 0) {
      return res.status(402).json({ 
        error: 'Бесплатные генерации закончились',
        needPayment: true,
        message: 'У вас закончились бесплатные генерации на этот месяц. Оформите подписку, чтобы продолжить.'
      });
    }

    let structure = '';
    if (reportType === 'esg') {
      structure = `1. Титульный лист
2. Обзор ESG-стратегии
3. Экологические показатели
4. Социальные показатели
5. Управленческие показатели
6. Достижения и сертификаты
7. Цели на следующий период
8. Выводы и рекомендации`;
    } else if (slidesCount <= 5) {
      structure = `1. Титульный лист
2. Executive summary
3. Ключевые финансовые показатели
4. Анализ эффективности
5. Выводы и рекомендации`;
    } else if (slidesCount <= 8) {
      structure = `1. Титульный лист
2. Executive summary
3. Ключевые финансовые показатели
4. Анализ доходов и расходов
5. Анализ ликвидности
6. Анализ денежного потока
7. Сравнение с предыдущим периодом
8. Выводы и рекомендации`;
    } else {
      structure = `1. Титульный лист
2. Executive summary
3. Ключевые финансовые показатели
4. Анализ доходов по сегментам
5. Анализ расходов по категориям
6. Анализ рентабельности
7. Анализ ликвидности
8. Анализ долговой нагрузки
9. Анализ денежного потока
10. Сравнение с предыдущим периодом
11. Сравнение с конкурентами
12. Анализ рисков
13. Прогноз на следующий период
14. Рекомендации для руководства
15. Приложения`;
    }

    const prompt = `Ты — профессиональный финансовый аналитик. Создай подробный ${reportTypeName} для компании "${company}" за период "${period}" по стандарту ${standardName}. Количество слайдов: ${slidesCount}.

СТРУКТУРА ОТЧЁТА:
${structure}

ТРЕБОВАНИЯ:
- Используй РЕАЛИСТИЧНЫЕ ЦИФРЫ (миллионы рублей, проценты, коэффициенты)
- Данные должны выглядеть как настоящий отчёт
- Добавляй аналитику, выводы и рекомендации
- Для ESG отчёта добавь экологические и социальные показатели

Верни ТОЛЬКО JSON в формате:
{
  "title": "${reportTypeName}: ${company}",
  "company": "${company}",
  "period": "${period}",
  "standard": "${standardName}",
  "reportType": "${reportTypeName}",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": [
        "Пункт 1 с конкретными цифрами (20-40 слов)",
        "Пункт 2 с аналитикой (20-40 слов)",
        "Пункт 3 с выводом (15-25 слов)",
        "Пункт 4 с рекомендацией (15-25 слов)"
      ]
    }
  ]
}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "8000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 90000 
    });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    
    let reportData = JSON.parse(cleanText);
    
    if (!reportData.slides || reportData.slides.length === 0) {
      reportData.slides = [];
    }
    
    if (reportData.slides.length > slidesCount) {
      reportData.slides = reportData.slides.slice(0, slidesCount);
    }
    
    while (reportData.slides.length < slidesCount) {
      const i = reportData.slides.length;
      reportData.slides.push({
        title: `Раздел ${i + 1}`,
        content: [
          `Дополнительный анализ по компании "${company}".`,
          `Показатели соответствуют стандартам ${standardName}.`,
          `Рекомендуется обновить информацию при наличии новых данных.`
        ]
      });
    }

    user = await decrementGenerations(user);
    
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO generation_history (user_id, type, title, slide_count, created_at)
         VALUES ($1, 'report', $2, $3, NOW())`,
        [user.id, company, slidesCount]
      );
    }
    
    res.json(reportData);
    
  } catch (e) {
    console.error('❌ Report generation error:', e.message);
    res.status(500).json({ error: 'Ошибка генерации отчёта' });
  }
});

// ═══════════════════════════════════════════════════════════════
// IMPROVE TEXT
// ═══════════════════════════════════════════════════════════════
app.post('/api/improve', optionalAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Текст не указан' });

    const prompt = `Улучши текст для презентации. Сделай его профессиональнее. Исходный текст: "${text}". Верни только улучшенный текст.`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.6, maxTokens: "500" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 20000 
    });

    const improved = response.data.result.alternatives[0].message.text.trim();
    res.json({ original: text, improved: improved });
  } catch (e) {
    res.json({ original: req.body.text, improved: req.body.text });
  }
});

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════
app.post('/api/export/pptx', optionalAuth, async (req, res) => {
  res.json({ success: true, message: 'PPTX готов' });
});

app.post('/api/export/pdf', optionalAuth, async (req, res) => {
  const user = req.user;
  if (!user.is_premium && !user.is_vip && user.id !== 'guest') {
    return res.status(403).json({ error: 'Premium доступ required' });
  }
  res.json({ success: true, message: 'PDF готов' });
});

// ═══════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════
app.get('/api/history', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    
    if (user.id === 'guest' || !pool) {
      return res.json({ history: [] });
    }

    const result = await pool.query(
      `SELECT id, type, title, slide_count, created_at 
       FROM generation_history 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 20`,
      [user.id]
    );

    res.json({ history: result.rows.map(row => ({
      id: row.id,
      type: row.type,
      title: row.title,
      slideCount: row.slide_count,
      createdAt: row.created_at
    }))});
    
  } catch (e) {
    res.json({ history: [] });
  }
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT CALLBACK (CryptoCloud Postback)
// ═══════════════════════════════════════════════════════════════
app.post('/api/payment/callback', async (req, res) => {
  try {
    console.log('💰 Payment callback received:', JSON.stringify(req.body));
    
    const { 
      status, 
      order_id, 
      amount, 
      currency, 
      email,
      plan,
      promo_code 
    } = req.body;
    
    // Проверяем, что платёж успешен
    if (status !== 'success' && status !== 'completed') {
      console.log(`⚠️ Payment not successful: ${status}`);
      return res.json({ success: true });
    }
    
    if (!pool) {
      console.log('⚠️ No database, skipping activation');
      return res.json({ success: true });
    }
    
    // Определяем срок подписки
    let durationMonths = 1;
    let planName = 'monthly';
    if (plan === 'Полгода' || plan === 'half_year' || plan === 'half') {
      durationMonths = 6;
      planName = 'half_year';
    } else if (plan === 'Год' || plan === 'year') {
      durationMonths = 12;
      planName = 'year';
    }
    
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + durationMonths);
    
    // Ищем пользователя по email
    let userId = null;
    let userEmail = null;
    
    if (email) {
      const userResult = await pool.query(
        'SELECT id, email FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
      if (userResult.rows.length > 0) {
        userId = userResult.rows[0].id;
        userEmail = userResult.rows[0].email;
      }
    }
    
    if (userId) {
      // Активируем Premium
      await pool.query(
        `UPDATE users 
         SET is_premium = TRUE, 
             premium_expiry = $1,
             free_generations_left = 9999,
             monthly_generations_left = 9999
         WHERE id = $2`,
        [expiry, userId]
      );
      
      console.log(`✅ Premium activated for user ${userId} until ${expiry}`);
      
      // Сохраняем информацию о подписке
      await pool.query(
        `INSERT INTO user_subscriptions (user_id, plan, amount, expires_at, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userId, planName, amount, expiry]
      );
      
      // Проверяем, есть ли бонусный месяц (CRYPTO10)
      const bonusResult = await pool.query(
        `SELECT * FROM user_bonus_months 
         WHERE user_id = $1 AND is_used = FALSE AND bonus_month = 2`,
        [userId]
      );
      
      if (bonusResult.rows.length > 0) {
        await pool.query(
          `UPDATE user_bonus_months SET is_used = TRUE WHERE id = $1`,
          [bonusResult.rows[0].id]
        );
        
        await pool.query(
          `UPDATE users 
           SET premium_expiry = premium_expiry + INTERVAL '1 month'
           WHERE id = $1 AND is_premium = TRUE`,
          [userId]
        );
        
        console.log(`🎁 Bonus second month applied for user ${userId}`);
      }
      
      // Отправляем email-уведомление
      if (userEmail) {
        try {
          const expiryDate = expiry.toLocaleDateString('ru-RU');
          await transporter.sendMail({
            from: `"Презентатор ИИ" <${FROM_EMAIL}>`,
            to: userEmail,
            subject: 'Подписка активирована! 🎉',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #121212; color: #ffffff; border-radius: 16px;">
                <h2 style="color: #1DB954;">Спасибо за покупку!</h2>
                <p>Ваша Premium-подписка активирована.</p>
                <p><strong>План:</strong> ${planName === 'monthly' ? 'Месячный' : planName === 'half_year' ? '6 месяцев' : 'Годовой'}</p>
                <p><strong>Действует до:</strong> ${expiryDate}</p>
                <p>Теперь у вас безлимитный доступ ко всем функциям:</p>
                <ul>
                  <li>✅ Безлимит презентаций</li>
                  <li>✅ До 50 слайдов</li>
                  <li>✅ Экспорт в PDF без водяного знака</li>
                  <li>✅ Загрузка своих картинок и логотипов</li>
                </ul>
                <a href="https://app.prezentator-ai.com" style="display: inline-block; background: #1DB954; color: #000; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin-top: 16px; font-weight: bold;">Перейти в приложение</a>
                <p style="margin-top: 24px; font-size: 12px; color: #666;">Если у вас есть вопросы, ответьте на это письмо или напишите в поддержку.</p>
              </div>
            `
          });
          console.log(`📧 Email sent to ${userEmail}`);
        } catch (emailError) {
          console.error('❌ Failed to send email:', emailError.message);
        }
      }
      
      // Записываем аналитику
      await pool.query(
        `INSERT INTO promocode_analytics (promocode_id, action, user_id, created_at)
         VALUES ($1, 'payment_success', $2, NOW())`,
        [promo_code ? (await pool.query('SELECT id FROM promocodes WHERE code = $1', [promo_code])).rows[0]?.id : null, userId]
      );
      
    } else {
      console.log('⚠️ No user found for payment');
    }
    
    res.json({ success: true });
    
  } catch (e) {
    console.error('❌ Payment callback error:', e.message);
    res.status(500).json({ error: 'Error processing payment' });
  }
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

async function initDatabase() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        name VARCHAR(255),
        country VARCHAR(10),
        is_premium BOOLEAN DEFAULT FALSE,
        premium_expiry TIMESTAMPTZ,
        free_generations_left INTEGER DEFAULT 5,
        monthly_generations_left INTEGER DEFAULT 5,
        last_reset_date TIMESTAMPTZ DEFAULT NOW(),
        total_generations INTEGER DEFAULT 0,
        surprise_uses_left INTEGER DEFAULT 3,
        email_verified BOOLEAN DEFAULT FALSE,
        verification_token VARCHAR(255),
        last_login TIMESTAMPTZ,
        failed_login_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        social_id VARCHAR(255) UNIQUE,
        social_provider VARCHAR(50),
        avatar_url TEXT,
        is_vip BOOLEAN DEFAULT FALSE,
        vip_activated_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) UNIQUE NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS generation_history (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(500) NOT NULL,
        slide_count INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS promocodes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        discount_type VARCHAR(20) NOT NULL,
        discount_value DECIMAL(10,2),
        description TEXT,
        max_uses INT DEFAULT 1,
        used_count INT DEFAULT 0,
        valid_from TIMESTAMP DEFAULT NOW(),
        valid_until TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS promocode_usages (
        id SERIAL PRIMARY KEY,
        promocode_id INT REFERENCES promocodes(id),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        used_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS user_bonus_months (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        bonus_month INTEGER NOT NULL,
        applied_at TIMESTAMP DEFAULT NOW(),
        promocode_id INTEGER REFERENCES promocodes(id),
        is_used BOOLEAN DEFAULT FALSE
      );
      
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(50) NOT NULL,
        amount DECIMAL(10,2),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS promocode_analytics (
        id SERIAL PRIMARY KEY,
        promocode_id INTEGER REFERENCES promocodes(id),
        action VARCHAR(50),
        user_id UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Tables created');
    
    // Вставка промокодов
    await pool.query(`
      INSERT INTO promocodes (code, discount_type, discount_value, description, max_uses) VALUES
      ('CRYPTO10', 'free_month', NULL, 'Second month free for first 10 paying users', 10),
      ('CRYPTO50', 'percent', 50, '50%% off first month for testers', 20),
      ('BLOGGER', 'percent', 30, '30%% off for blogger subscribers', 50)
      ON CONFLICT (code) DO NOTHING
    `);
    console.log('✅ Promocodes inserted');
    
  } catch (e) {
    console.error('❌ Database init error:', e.message);
  }
}

setInterval(async () => {
  try {
    await axios.get(`http://localhost:${PORT}/api/health`, { timeout: 5000 });
  } catch (e) {}
}, 300000);

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
    console.log(`📊 DB: ${pool ? 'connected' : 'DEMO mode'}`);
    console.log(`💰 Postback URL: /api/payment/callback`);
    console.log(`🎟️ Promocodes: CRYPTO10, CRYPTO50, BLOGGER`);
  });
});