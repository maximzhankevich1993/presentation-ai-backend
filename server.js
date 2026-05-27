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
const CACHE_TTL = 1000 * 60 * 60; // 1 час

// Счётчик для гостей (в памяти)
const guestGenerationCounter = new Map();

// Очистка счётчика гостей раз в сутки
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

// Проверка и сброс ежемесячных генераций
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

// Уменьшение счётчика генераций
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

function getCountryNameForQuiz(code) {
  const countries = {
    'RU': 'Россия', 'BY': 'Беларусь', 'KZ': 'Казахстан',
    'UA': 'Украина', 'US': 'США', 'GB': 'Великобритания',
    'DE': 'Германия', 'FR': 'Франция', 'IT': 'Италия',
    'ES': 'Испания', 'PL': 'Польша', 'TR': 'Турция',
    'CN': 'Китай', 'IN': 'Индия', 'BR': 'Бразилия'
  };
  return countries[code] || 'международный';
}

function getDefaultStages(topic, durationMinutes) {
  const stageMinutes = Math.floor(durationMinutes / 5);
  return [
    {
      name: 'Организационный момент',
      minutes: 5,
      teacherActions: 'Приветствие, проверка готовности к уроку',
      studentActions: 'Подготовка рабочих мест',
      resources: 'Презентация, доска'
    },
    {
      name: 'Актуализация знаний',
      minutes: stageMinutes,
      teacherActions: `Опрос по теме "${topic}", введение в новый материал`,
      studentActions: 'Ответы на вопросы, обсуждение',
      resources: 'Вопросы для обсуждения, карточки'
    },
    {
      name: 'Изучение нового материала',
      minutes: stageMinutes * 2,
      teacherActions: `Объяснение темы "${topic}", демонстрация примеров`,
      studentActions: 'Конспектирование, задавание вопросов',
      resources: 'Видеоматериалы, схемы, таблицы'
    },
    {
      name: 'Закрепление материала',
      minutes: stageMinutes,
      teacherActions: 'Практические задания, контроль понимания',
      studentActions: 'Выполнение упражнений, работа в парах',
      resources: 'Рабочие листы, карточки с заданиями'
    },
    {
      name: 'Подведение итогов',
      minutes: 5,
      teacherActions: 'Анализ работы, выставление оценок',
      studentActions: 'Рефлексия, вопросы по теме',
      resources: 'Дневники, оценочные листы'
    }
  ];
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
    console.log('🔐 Вход:', email);
    
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
      console.log('❌ Пользователь не найден:', email);
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    let user = result.rows[0];
    console.log('✅ Пользователь найден:', user.email);

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Аккаунт заблокирован' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.log('❌ Неверный пароль');
      await pool.query(
        'UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1',
        [user.id]
      );
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    console.log('✅ Пароль верный');

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
      console.log('✅ Сессия создана');
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

app.post('/api/auth/forgot-password', async (req, res) => {
  if (!pool) return res.json({ success: true, message: 'Если email зарегистрирован, ссылка отправлена' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email обязателен' });

    const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.json({ success: true, message: 'Если email зарегистрирован, ссылка отправлена' });

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = await bcrypt.hash(resetToken, 10);

    await pool.query('INSERT INTO password_resets (user_id, token_hash) VALUES ($1, $2)', [user.id, resetTokenHash]);

    const resetLink = `https://presentation-ai.com/reset-password?token=${resetToken}&email=${email}`;

    await transporter.sendMail({
      from: `"Презентатор ИИ" <${FROM_EMAIL}>`,
      to: email,
      subject: 'Восстановление пароля',
      html: `<h2>Сброс пароля</h2><p>Здравствуйте, ${user.name}!</p><a href="${resetLink}" style="padding:14px 28px;background:#1DB954;color:white;text-decoration:none;border-radius:8px;">Сбросить пароль</a><p style="color:#666;font-size:12px;">Ссылка действительна 1 час.</p>`
    });

    console.log(`✅ Письмо сброса: ${email}`);
    res.json({ success: true, message: 'Ссылка отправлена на email' });
  } catch (e) {
    console.error('Forgot:', e);
    res.status(500).json({ error: 'Ошибка' });
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
// GENERATE (ПРЕЗЕНТАЦИИ)
// ═══════════════════════════════════════════════════════════════
app.post('/api/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, slideCount, maxSlides } = req.body;
    const slidesCount = slideCount || maxSlides || 5;
    
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    let user = req.user;
    console.log(`🎯 Генерация: "${topic}" (${slidesCount} слайдов) - ${user.email}, осталось: ${user.free_generations_left}`);

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
      console.log(`📦 Кэш: "${topic}" - ${user.email}`);
      
      user = await decrementGenerations(user);
      return res.json(cached);
    }

    const minWords = 45;
    const maxWords = 60;

    const prompt = `Ты — эксперт по созданию презентаций. Создай структуру презентации на тему: "${topic}". Количество слайдов: ${slidesCount}.

ПРАВИЛА:
- Каждый слайд: ЗАГОЛОВОК (5-8 слов) + 4-6 пунктов
- Длина КАЖДОГО пункта: ${minWords}-${maxWords} слов
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
    
    console.log(`✅ ${presentation.slides?.length || 0} слайдов`);
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
    
    console.log(`📚 Генерация урока: "${topic}" (${slidesCount} слайдов, ${subject}) - ${user.email}, осталось: ${user.free_generations_left}`);

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
    
    while (lessonData.slides.length < slidesCount) {
      lessonData.slides.push({
        title: `${lessonData.slides.length + 1}. Вопрос по теме "${topic}"`,
        content: [
          `Ключевой аспект темы "${topic}" требует внимательного изучения.`,
          `Статистика показывает важность этого вопроса в ${subject}.`,
          `Как вы думаете, почему это важно для понимания темы?`,
          `Рекомендуется запомнить этот материал для дальнейшего изучения.`
        ]
      });
    }

    user = await decrementGenerations(user);
    
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
    
    console.log(`📝 Генерация теста: "${topic}" - ${user.email}, осталось: ${user.free_generations_left}`);

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
      
      user = await decrementGenerations(user);
      
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
    
    console.log(`📝 Генерация теста из презентации: "${title}" - ${user.email}`);

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
      
      user = await decrementGenerations(user);
      
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
    
    console.log(`📊 Генерация отчёта: "${company}" (${slidesCount} слайдов, ${reportTypeName}, ${standardName}) - ${user.email}, осталось: ${user.free_generations_left}`);

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
3. Экологические показатели (выбросы CO2, энергопотребление, отходы)
4. Социальные показатели (сотрудники, безопасность, обучение)
5. Управленческие показатели (комплаенс, антикоррупция)
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
3. Ключевые финансовые показатели (выручка, EBITDA, чистая прибыль)
4. Анализ доходов по сегментам
5. Анализ расходов по категориям
6. Анализ рентабельности
7. Анализ ликвидности (коэффициенты)
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
    
    const targetCount = slidesCount;
    if (reportData.slides.length < targetCount) {
      for (let i = reportData.slides.length; i < targetCount; i++) {
        if (i === 0) {
          reportData.slides.push({
            title: 'Титульный лист',
            content: [company, `Отчёт за ${period}`, standardName]
          });
        } else if (i === 1) {
          reportData.slides.push({
            title: 'Ключевые показатели',
            content: ['Выручка: ________ млн ₽', 'Прибыль: ________ млн ₽', 'Рентабельность: ________%']
          });
        } else {
          reportData.slides.push({
            title: `Раздел ${i + 1}`,
            content: [
              `Дополнительный анализ по компании "${company}".`,
              `Показатели соответствуют стандартам ${standardName}.`,
              `Рекомендуется обновить информацию при наличии новых данных.`
            ]
          });
        }
      }
    }

    user = await decrementGenerations(user);
    
    console.log(`✅ Отчёт создан: "${company}" (${reportData.slides.length} слайдов)`);
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
  try {
    const { title } = req.body;
    console.log(`📤 Экспорт PPTX: "${title}"`);
    res.json({ success: true, message: 'PPTX готов' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка экспорта PPTX' });
  }
});

app.post('/api/export/pdf', optionalAuth, async (req, res) => {
  try {
    const { title } = req.body;
    const user = req.user;
    
    if (!user.is_premium && !user.is_vip && user.id !== 'guest') {
      return res.status(403).json({ error: 'Premium доступ required' });
    }
    
    console.log(`📤 Экспорт PDF: "${title}"`);
    res.json({ success: true, message: 'PDF готов' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка экспорта PDF' });
  }
});

// ═══════════════════════════════════════════════════════════════
// HISTORY, REFERRAL, VIP, IMAGES
// ═══════════════════════════════════════════════════════════════
app.get('/api/history', optionalAuth, async (req, res) => {
  res.json({ history: [] });
});

app.delete('/api/history/:id', optionalAuth, async (req, res) => {
  res.json({ success: true });
});

app.get('/api/referral/stats', optionalAuth, async (req, res) => {
  res.json({ code: 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase(), referralsCount: 0, bonusGenerations: 0, friends: [] });
});

app.post('/api/referral/apply', async (req, res) => {
  res.json({ success: true });
});

app.post('/api/referral/activate', optionalAuth, async (req, res) => {
  res.json({ success: true });
});

app.post('/api/referral/premium-activated', optionalAuth, async (req, res) => {
  res.json({ success: true });
});

app.get('/api/vip/stats', async (req, res) => {
  res.json({ occupiedSpots: 5, totalSpots: 50, availableSpots: 45 });
});

app.post('/api/vip/purchase', optionalAuth, async (req, res) => {
  res.json({ success: true, message: 'VIP статус активирован' });
});

app.post('/api/images/search', async (req, res) => {
  res.json({ images: [] });
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
    `);
    console.log('✅ Таблицы созданы');
  } catch (e) {
    console.error('❌ Ошибка создания таблиц:', e.message);
  }
}

// Пинг для предотвращения холодного старта
setInterval(async () => {
  try {
    await axios.get(`http://localhost:${PORT}/api/health`, { timeout: 5000 });
  } catch (e) {
    // тихо
  }
}, 300000);

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Сервер на порту ${PORT}`);
    console.log(`📊 БД: ${pool ? 'подключена' : 'DEMO режим'}`);
    console.log(`🎁 Бесплатных генераций: 5 в месяц`);
    console.log(`📚 Конструктор уроков: полноценные уроки, до 10 слайдов`);
    console.log(`📊 Конструктор отчётов: полноценные отчёты, до 15 слайдов (бесплатно до 10)`);
    console.log(`⚡ Кэш включён, пинг включён`);
  });
});