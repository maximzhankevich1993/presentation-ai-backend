const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Загружаем .env для локальной разработки
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ 
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], 
  allowedHeaders: ['Content-Type', 'Authorization'] 
}));
app.use(express.json({ limit: '1mb' }));

// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════
const pool = process.env.DATABASE_URL 
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ═══════════════════════════════════════════════════════════════
// YANDEX GPT
// ═══════════════════════════════════════════════════════════════
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

// ═══════════════════════════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════════════════════════
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

// Проверка ключей при старте
if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
  console.error('❌ YANDEX_API_KEY и YANDEX_FOLDER_ID обязательны');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
async function authMiddleware(req, res, next) {
  if (!pool) {
    req.user = { id: 'demo', email: 'demo@demo.com', name: 'Demo', is_premium: true, free_generations_left: 999 };
    return next();
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.is_premium, u.premium_expiry, u.free_generations_left
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Сессия истекла' });
    }

    req.user = result.rows[0];
    next();
  } catch (e) {
    console.error('Auth error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    version: '7.0.0', 
    api: 'YandexGPT',
    db: !!pool
  });
});

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

// Регистрация
app.post('/api/auth/register', async (req, res) => {
  if (!pool) {
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: req.body.name || 'Demo' } });
  }

  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, verification_token, free_generations_left)
       VALUES ($1, $2, $3, $4, 10)
       RETURNING id, email, name, created_at`,
      [email.toLowerCase(), passwordHash, name || email.split('@')[0], verificationToken]
    );

    const user = result.rows[0];

    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    try {
      await transporter.sendMail({
        from: `"Презентатор ИИ" <${FROM_EMAIL}>`,
        to: email,
        subject: 'Добро пожаловать в Презентатор ИИ! 🎉',
        html: `<div style="font-family:Arial;max-width:480px;margin:0 auto;"><h2 style="color:#1DB954;">Добро пожаловать, ${user.name}!</h2><p>Ваш аккаунт создан.</p><p>🎁 <strong>10 бесплатных генераций</strong> уже ждут вас.</p></div>`
      });
    } catch (e) {}

    res.json({ token: sessionToken, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

// Вход
app.post('/api/auth/login', async (req, res) => {
  if (!pool) {
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: 'Demo', isPremium: true, freeGenerationsLeft: 999 } });
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    const result = await pool.query(
      'SELECT id, email, name, password_hash, is_premium, premium_expiry, free_generations_left, failed_login_attempts, locked_until FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const user = result.rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Аккаунт заблокирован. Попробуйте позже.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await pool.query(
        'UPDATE users SET failed_login_attempts = failed_login_attempts + 1, locked_until = CASE WHEN failed_login_attempts >= 4 THEN NOW() + INTERVAL \'15 minutes\' ELSE NULL END WHERE id = $1',
        [user.id]
      );
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );

    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    res.json({
      token: sessionToken,
      user: {
        id: user.id, email: user.email, name: user.name,
        isPremium: user.is_premium, premiumExpiry: user.premium_expiry,
        freeGenerationsLeft: user.free_generations_left
      }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// Восстановление пароля
app.post('/api/auth/forgot-password', async (req, res) => {
  if (!pool) {
    return res.json({ success: true, message: 'Если email зарегистрирован, ссылка отправлена' });
  }

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email обязателен' });

    const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase()]);

    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'Если email зарегистрирован, ссылка отправлена' });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = await bcrypt.hash(resetToken, 10);

    await pool.query(
      `CREATE TABLE IF NOT EXISTS password_resets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );

    await pool.query(
      'INSERT INTO password_resets (user_id, token_hash) VALUES ($1, $2)',
      [user.id, resetTokenHash]
    );

    const resetLink = `https://presentation-ai.com/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

    await transporter.sendMail({
      from: `"Презентатор ИИ" <${FROM_EMAIL}>`,
      to: email,
      subject: 'Восстановление пароля',
      html: `<div style="font-family:Arial;max-width:480px;margin:0 auto;"><h2>Восстановление пароля</h2><p>Здравствуйте, ${user.name}!</p><p>Нажмите кнопку для сброса пароля:</p><a href="${resetLink}" style="display:inline-block;padding:14px 28px;background:#1DB954;color:white;text-decoration:none;border-radius:8px;font-weight:bold;">Сбросить пароль</a><p style="color:#666;font-size:12px;margin-top:20px;">Ссылка действительна 1 час.</p></div>`
    });

    console.log(`✅ Письмо сброса: ${email}`);
    res.json({ success: true, message: 'Ссылка отправлена на email' });
  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: 'Ошибка отправки' });
  }
});

// Сброс пароля
app.post('/api/auth/reset-password', async (req, res) => {
  if (!pool) return res.json({ success: true, message: 'Пароль изменён (demo)' });

  try {
    const { token, email, newPassword } = req.body;

    if (!token || !email || !newPassword) return res.status(400).json({ error: 'Все поля обязательны' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Минимум 6 символов' });

    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) return res.status(400).json({ error: 'Неверный токен' });

    const userId = userResult.rows[0].id;

    const tokenResult = await pool.query(
      'SELECT id, token_hash FROM password_resets WHERE user_id = $1 AND used = FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    if (tokenResult.rows.length === 0) return res.status(400).json({ error: 'Токен истёк или недействителен' });

    const reset = tokenResult.rows[0];
    const valid = await bcrypt.compare(token, reset.token_hash);
    if (!valid) return res.status(400).json({ error: 'Неверный токен' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

    res.json({ success: true, message: 'Пароль успешно изменён' });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: 'Ошибка сброса пароля' });
  }
});

// Выход
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  if (!pool) return res.json({ success: true });

  try {
    const token = req.headers.authorization.replace('Bearer ', '');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Профиль
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ═══════════════════════════════════════════════════════════════
// GENERATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/generate', authMiddleware, async (req, res) => {
  try {
    const { topic, maxSlides = 5 } = req.body;
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    const user = req.user;
    if (!user.is_premium && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились. Оформите Premium.' });
    }

    console.log(`🎯 Генерация: "${topic}" для ${user.email}`);

    const prompt = `Ты — эксперт. Создай структуру презентации: "${topic}". Слайдов: ${maxSlides}.

ПРАВИЛА:
- Конкретные факты, цифры, примеры
- Заголовки содержательные, НЕ вопросы
- Структура: Введение → Факты → Примеры → Выводы
- Минимум 3 содержательных пункта на слайд

Верни ТОЛЬКО JSON:
{"title":"Название","slides":[{"title":"Заголовок","content":["Факт 1","Факт 2","Факт 3"]}]}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.6, maxTokens: "4000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 45000 
    });

    const text = response.data.result.alternatives[0].message.text;
    const cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const presentation = JSON.parse(cleanText);

    if (pool && !user.is_premium) {
      await pool.query(
        'UPDATE users SET free_generations_left = free_generations_left - 1, total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    } else if (pool) {
      await pool.query('UPDATE users SET total_generations = total_generations + 1 WHERE id = $1', [user.id]);
    }
    
    console.log(`✅ ${presentation.slides?.length || 0} слайдов`);
    res.json(presentation);
  } catch (error) {
    console.error('❌ Ошибка генерации:', error.message);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

// Улучшение текста
app.post('/api/improve', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Текст не указан' });

    const prompt = `Улучши текст для презентации. Верни ТОЛЬКО улучшенный текст.\n\nИсходный: "${text}"\n\nУлучшенный:`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.5, maxTokens: "800" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 15000 
    });

    res.json({ original: text, improved: response.data.result.alternatives[0].message.text.trim() });
  } catch (e) {
    res.json({ original: req.body.text, improved: req.body.text });
  }
});

// Картинки
app.post('/api/images/search', async (req, res) => {
  res.json({ images: [], keywords: req.body.keywords, placeholder: true });
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Сервер на порту ${PORT}`);
  console.log(`📊 БД: ${pool ? 'подключена' : 'отключена (demo режим)'}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
});