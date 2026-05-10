const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ═══════════════════════════════════════════════════════════════
// YANDEX GPT
// ═══════════════════════════════════════════════════════════════
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

// ═══════════════════════════════════════════════════════════════
// EMAIL (SendGrid / SMTP)
// ═══════════════════════════════════════════════════════════════
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'apikey',
    pass: process.env.SMTP_PASS || process.env.SENDGRID_API_KEY
  }
});

// Проверка ключей при старте
if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
  console.error('❌ YANDEX_API_KEY и YANDEX_FOLDER_ID обязательны');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
async function authMiddleware(req, res, next) {
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
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    // Проверка существующего пользователя
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    // Хешируем пароль
    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Создаём пользователя
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, verification_token, free_generations_left)
       VALUES ($1, $2, $3, $4, 10)
       RETURNING id, email, name, created_at`,
      [email.toLowerCase(), passwordHash, name || email.split('@')[0], verificationToken]
    );

    const user = result.rows[0];

    // Создаём сессию
    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    // Отправляем приветственное письмо
    try {
      await transporter.sendMail({
        from: `"Презентатор ИИ" <${process.env.FROM_EMAIL || 'noreply@presentation-ai.com'}>`,
        to: email,
        subject: 'Добро пожаловать в Презентатор ИИ! 🎉',
        html: `
          <div style="font-family: Arial; max-width: 480px; margin: 0 auto;">
            <h2 style="color: #1DB954;">С возвращением, ${user.name}!</h2>
            <p>Ваш аккаунт успешно создан.</p>
            <p>🎁 Вы получили <strong>10 бесплатных генераций</strong> презентаций.</p>
            <a href="https://presentation-ai.com" 
               style="display: inline-block; padding: 12px 24px; background: #1DB954; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Начать создавать
            </a>
          </div>
        `
      });
    } catch (e) {
      console.error('Email send error:', e.message);
    }

    res.json({
      token: sessionToken,
      user: { id: user.id, email: user.email, name: user.name }
    });

  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

// Вход
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    // Ищем пользователя
    const result = await pool.query(
      'SELECT id, email, name, password_hash, is_premium, premium_expiry, free_generations_left, failed_login_attempts, locked_until FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const user = result.rows[0];

    // Проверка блокировки
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Аккаунт заблокирован. Попробуйте позже.' });
    }

    // Проверка пароля
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await pool.query(
        'UPDATE users SET failed_login_attempts = failed_login_attempts + 1, locked_until = CASE WHEN failed_login_attempts >= 4 THEN NOW() + INTERVAL \'15 minutes\' ELSE NULL END WHERE id = $1',
        [user.id]
      );
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    // Сбрасываем попытки
    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // Создаём сессию
    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    res.json({
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: user.is_premium,
        premiumExpiry: user.premium_expiry,
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
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email обязателен' });
    }

    const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase()]);

    // Всегда возвращаем успех, чтобы не раскрывать существование email
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'Если email зарегистрирован, ссылка отправлена' });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = await bcrypt.hash(resetToken, 10);

    // Сохраняем токен в отдельной таблице (создадим её)
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

    // Отправляем email
    await transporter.sendMail({
      from: `"Презентатор ИИ" <${process.env.FROM_EMAIL || 'noreply@presentation-ai.com'}>`,
      to: email,
      subject: 'Восстановление пароля',
      html: `
        <div style="font-family: Arial; max-width: 480px; margin: 0 auto;">
          <h2>Восстановление пароля</h2>
          <p>Здравствуйте, ${user.name}!</p>
          <p>Вы запросили сброс пароля. Нажмите кнопку ниже, чтобы создать новый пароль:</p>
          <a href="${resetLink}" 
             style="display: inline-block; padding: 14px 28px; background: #1DB954; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Сбросить пароль
          </a>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">
            Ссылка действительна 1 час. Если вы не запрашивали сброс, просто игнорируйте это письмо.
          </p>
        </div>
      `
    });

    console.log(`✅ Письмо для сброса пароля отправлено: ${email}`);
    res.json({ success: true, message: 'Ссылка для сброса отправлена на email' });

  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: 'Ошибка отправки' });
  }
});

// Сброс пароля
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, email, newPassword } = req.body;

    if (!token || !email || !newPassword) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Минимум 6 символов' });
    }

    // Ищем пользователя
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Неверный токен' });
    }

    const userId = userResult.rows[0].id;

    // Ищем валидный токен
    const tokenResult = await pool.query(
      'SELECT id, token_hash FROM password_resets WHERE user_id = $1 AND used = FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(400).json({ error: 'Токен истёк или недействителен' });
    }

    const reset = tokenResult.rows[0];
    const valid = await bcrypt.compare(token, reset.token_hash);

    if (!valid) {
      return res.status(400).json({ error: 'Неверный токен' });
    }

    // Обновляем пароль
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);

    // Удаляем все старые сессии
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

    res.json({ success: true, message: 'Пароль успешно изменён' });

  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: 'Ошибка сброса пароля' });
  }
});

// Выход
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try {
    const token = req.headers.authorization.replace('Bearer ', '');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GENERATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/generate', authMiddleware, async (req, res) => {
  try {
    const { topic, maxSlides = 5 } = req.body;
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    // Проверка лимитов
    const user = req.user;
    if (!user.is_premium && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились. Оформите Premium.' });
    }

    console.log(`🎯 Генерация: "${topic}" для ${user.email}`);

    const prompt = `Ты — эксперт и профессиональный спикер. Создай детальную структуру презентации на тему: "${topic}".

Количество слайдов: ${maxSlides}

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА:
1. Каждый слайд должен содержать КОНКРЕТНЫЕ факты, цифры, примеры, определения.
2. ИСПОЛЬЗУЙ точные данные: даты, проценты, имена учёных, названия открытий.
3. Заголовки — содержательные и конкретные, НЕ вопросы.
4. СТРУКТУРА: Введение → Факты/Детали → Примеры/Применение → Выводы
5. Минимум 3 пункта в каждом слайде. Каждый пункт — 1-2 предложения с фактами.

Верни ТОЛЬКО валидный JSON, без markdown. Формат:
{
  "title": "Название",
  "slides": [
    {
      "title": "Конкретный заголовок",
      "content": ["Детальный факт с цифрами", "Детальный факт с цифрами", "Детальный факт с цифрами"]
    }
  ]
}`;

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

    // Списываем генерацию
    if (!user.is_premium) {
      await pool.query(
        'UPDATE users SET free_generations_left = free_generations_left - 1, total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    } else {
      await pool.query('UPDATE users SET total_generations = total_generations + 1 WHERE id = $1', [user.id]);
    }
    
    console.log(`✅ Сгенерировано ${presentation.slides?.length || 0} слайдов`);
    res.json(presentation);

  } catch (error) {
    console.error('❌ Ошибка генерации:', error.message);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

// ═══════════════════════════════════════════════════════════════
// TEXT IMPROVE
// ═══════════════════════════════════════════════════════════════
app.post('/api/improve', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Текст не указан' });

    const prompt = `Улучши текст для презентации. Сделай профессиональнее и убедительнее. Верни ТОЛЬКО улучшенный текст, без пояснений.\n\nИсходный текст: "${text}"\n\nУлучшенный текст:`;

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

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`📝 Auth:   POST /api/auth/register | /api/auth/login | /api/auth/forgot-password`);
  console.log(`🎯 Generate: POST /api/generate (🔒 auth)`);
  console.log(`✨ Improve:  POST /api/improve (🔒 auth)`);
});