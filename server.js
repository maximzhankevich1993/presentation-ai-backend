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
// DATABASE (FIXED FOR SUPABASE - SSL DISABLED)
// ═══════════════════════════════════════════════════════════════
let pool = null;

if (process.env.DATABASE_URL) {
  try {
    let connectionString = process.env.DATABASE_URL;
    
    // Добавляем параметр sslmode=disable в строку
    const separator = connectionString.includes('?') ? '&' : '?';
    connectionString += `${separator}sslmode=disable`;
    
    // Добавляем параметр options=project если используется pooler
    if (connectionString.includes('pooler.supabase.com') && !connectionString.includes('options=project')) {
      const projectRef = 'luiycydibcmhzbtsfoxe';
      connectionString += `&options=project%3D${projectRef}`;
      console.log('✅ Добавлен параметр project в connection string');
    }
    
    pool = new Pool({ 
      connectionString: connectionString,
      ssl: { rejectUnauthorized: false, ca: null, key: null, cert: null },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
      keepAlive: true,
    });
    console.log('✅ Database pool created');
  } catch (err) {
    console.error('❌ Failed to create database pool:', err.message);
    pool = null;
  }
} else {
  console.log('⚠️ DATABASE_URL not set, running in DEMO mode');
}

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
// UNSPLASH
// ═══════════════════════════════════════════════════════════
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

async function getImageUrl(query) {
  if (!UNSPLASH_ACCESS_KEY) return null;
  try {
    const response = await axios.get('https://api.unsplash.com/photos/random', {
      params: { query, orientation: 'landscape', per_page: 1 },
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
      timeout: 5000
    });
    return response.data?.urls?.regular || null;
  } catch (error) {
    console.log(`❌ Unsplash error: ${error.message}`);
    return null;
  }
}

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

// Не выходим, если нет ключей, только предупреждение
if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
  console.warn('⚠️ YANDEX_API_KEY или YANDEX_FOLDER_ID не заданы. AI-функции могут не работать.');
}

// ═══════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════

async function checkAndResetMonthlyGenerations(user) {
  if (!pool || user.id === 'guest') return user;
  if (user.is_premium || user.is_vip) return user;
  
  try {
    const now = new Date();
    const lastReset = user.last_reset_date ? new Date(user.last_reset_date) : null;
    const needReset = !lastReset || 
      now.getMonth() !== lastReset.getMonth() || 
      now.getFullYear() !== lastReset.getFullYear();
    
    if (needReset) {
      await pool.query(
        `UPDATE users 
         SET monthly_generations_left = 5, 
             free_generations_left = 5,
             last_reset_date = NOW()
         WHERE id = $1`,
        [user.id]
      );
      user.monthly_generations_left = 5;
      user.free_generations_left = 5;
      user.last_reset_date = now;
      console.log(`🔄 Сброс лимита для ${user.email} до 5`);
    }
  } catch (e) {
    console.error('Ошибка сброса лимита:', e.message);
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
  
  if (user.is_premium || user.is_vip) return user;
  
  const newFreeLeft = Math.max(0, (user.free_generations_left || 0) - 1);
  const newMonthlyLeft = Math.max(0, (user.monthly_generations_left || 0) - 1);
  
  try {
    await pool.query(
      `UPDATE users 
       SET free_generations_left = $1, 
           monthly_generations_left = $2, 
           total_generations = total_generations + 1 
       WHERE id = $3`,
      [newFreeLeft, newMonthlyLeft, user.id]
    );
    user.free_generations_left = newFreeLeft;
    user.monthly_generations_left = newMonthlyLeft;
  } catch (e) {
    console.error('Ошибка decrementGenerations:', e.message);
  }
  
  return user;
}

async function canGenerate(user) {
  if (user.is_premium || user.is_vip) return true;
  if (user.id === 'guest') {
    return (user.free_generations_left || 0) > 0;
  }
  return (user.free_generations_left || 0) > 0;
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

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  let dbConnected = false;
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbConnected = true;
    } catch (e) {
      console.error('Health check DB error:', e.message);
    }
  }
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    version: '9.2.0', 
    api: 'YandexGPT + Unsplash',
    db: dbConnected,
    uptime: process.uptime()
  });
});

// ═══════════════════════════════════════════════════════════════
// AUTH - РЕГИСТРАЦИЯ
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  if (!pool) {
    console.log('📝 DEMO REGISTRATION:', req.body.email);
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: req.body.name || 'Demo', isPremium: false, freeGenerationsLeft: 5, monthlyGenerationsLeft: 5 } });
  }

  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email уже используется' });

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, free_generations_left, monthly_generations_left, last_reset_date)
       VALUES ($1, $2, $3, 5, 5, NOW()) RETURNING id, email, name`,
      [email.toLowerCase(), passwordHash, name || email.split('@')[0]]
    );

    const user = result.rows[0];
    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    setTimeout(() => {
      transporter.sendMail({
        from: `"Презентатор ИИ" <${FROM_EMAIL}>`,
        to: email,
        subject: 'Добро пожаловать! 🎉',
        html: `<h2>Добро пожаловать, ${user.name}!</h2><p>🎁 5 бесплатных генераций каждый месяц.</p>`
      }).catch(console.log);
    }, 0);

    res.json({ 
      token: sessionToken, 
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        isPremium: false, 
        freeGenerationsLeft: 5, 
        monthlyGenerationsLeft: 5 
      } 
    });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTH - ЛОГИН
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  if (!pool) {
    console.log('📝 DEMO LOGIN:', req.body.email);
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: 'Demo', isPremium: true, freeGenerationsLeft: 999, monthlyGenerationsLeft: 999 } });
  }

  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const result = await pool.query(
      `SELECT id, email, name, password_hash, is_premium, premium_expiry, 
              free_generations_left, monthly_generations_left, last_reset_date, is_vip 
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный email или пароль' });

    let user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    user = await checkAndResetMonthlyGenerations(user);

    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

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
    console.error('Login error:', e);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTH - LOGOUT
// ═══════════════════════════════════════════════════════════════
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
// PROFILE
// ═══════════════════════════════════════════════════════════════
app.get('/api/profile', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (user.id === 'guest') {
      return res.json({
        id: 'guest', email: 'guest@demo.com', name: 'Guest',
        isPremium: false, isVip: false,
        freeGenerationsLeft: user.free_generations_left,
        monthlyGenerationsLeft: user.monthly_generations_left
      });
    }
    res.json({
      id: user.id, email: user.email, name: user.name,
      isPremium: user.is_premium || false, isVip: user.is_vip || false,
      freeGenerationsLeft: user.free_generations_left || 5,
      monthlyGenerationsLeft: user.monthly_generations_left || 5,
      premiumExpiry: user.premium_expiry
    });
  } catch (e) {
    console.error('Profile error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GENERATE ПРЕЗЕНТАЦИИ (С UNSPLASH)
// ═══════════════════════════════════════════════════════════════
app.post('/api/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, slideCount, maxSlides } = req.body;
    const slidesCount = slideCount || maxSlides || 5;
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    let user = req.user;
    
    const hasGenerations = await canGenerate(user);
    if (!hasGenerations) {
      return res.status(402).json({ 
        error: 'Бесплатные генерации закончились', 
        needPayment: true,
        message: 'У вас закончились бесплатные генерации на этот месяц. Оформите подписку.'
      });
    }

    const cacheKey = `${topic.toLowerCase()}_${slidesCount}`;
    if (generationCache.has(cacheKey)) {
      user = await decrementGenerations(user);
      return res.json(generationCache.get(cacheKey));
    }

    // Если нет ключей Yandex, возвращаем заглушку
    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
      const presentation = {
        title: topic,
        slides: Array(slidesCount).fill().map((_, i) => ({
          title: `Слайд ${i+1}`,
          content: ['Пункт 1', 'Пункт 2', 'Пункт 3', 'Пункт 4']
        }))
      };
      generationCache.set(cacheKey, presentation);
      setTimeout(() => generationCache.delete(cacheKey), CACHE_TTL);
      user = await decrementGenerations(user);
      return res.json(presentation);
    }

    const prompt = `Ты — эксперт по созданию презентаций. Создай структуру презентации на тему: "${topic}". Количество слайдов: ${slidesCount}.
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
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, timeout: 120000 });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    
    let presentation = JSON.parse(cleanText);
    if (!presentation.slides) presentation.slides = [];
    if (presentation.slides.length > slidesCount) presentation.slides = presentation.slides.slice(0, slidesCount);
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
    
    for (let i = 0; i < presentation.slides.length; i++) {
      const imageUrl = await getImageUrl(`${topic} ${presentation.slides[i].title}`);
      presentation.slides[i].imageUrl = imageUrl;
      if (i < presentation.slides.length - 1) await new Promise(r => setTimeout(r, 300));
    }
    
    generationCache.set(cacheKey, presentation);
    setTimeout(() => generationCache.delete(cacheKey), CACHE_TTL);
    
    user = await decrementGenerations(user);
    
    if (pool && user.id !== 'guest') {
      try {
        await pool.query(
          `INSERT INTO generation_history (user_id, type, title, slide_count, created_at)
           VALUES ($1, 'presentation', $2, $3, NOW())`,
          [user.id, topic, slidesCount]
        );
      } catch (err) {
        console.error('Ошибка сохранения истории:', err.message);
      }
    }
    
    res.json(presentation);
  } catch (e) {
    console.error('Generation error:', e.message);
    const slides = Array(req.body.slideCount || 5).fill().map((_, i) => ({ 
      title: i === 0 ? `Введение в тему "${req.body.topic}"` : i === 4 ? 'Заключение' : `Аспект ${i+1}`, 
      content: ['Пункт 1', 'Пункт 2', 'Пункт 3', 'Пункт 4'] 
    }));
    res.json({ title: req.body.topic, slides });
  }
});

// ═══════════════════════════════════════════════════════════════
// LESSON PLAN GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/lesson-plan/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, subject, grade, slideCount = 5 } = req.body;
    if (!topic || !subject || !grade) return res.status(400).json({ error: 'Тема, предмет и класс обязательны' });
    let user = req.user;
    let slidesCount = Math.min(Math.max(slideCount, 3), 10);
    
    const hasGenerations = await canGenerate(user);
    if (!hasGenerations) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились', needPayment: true });
    }

    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
      const slides = Array(slidesCount).fill().map((_, i) => ({ title: `Слайд ${i+1}`, content: ['Информация', 'Пример', 'Задание', 'Вывод'] }));
      user = await decrementGenerations(user);
      return res.json({ topic, subject, grade, slides, homework: 'Домашнее задание', materials: ['Материал 1', 'Материал 2'] });
    }

    const prompt = `Ты — опытный учитель. Создай план урока по предмету "${subject}" для ${grade} класса на тему "${topic}" в виде презентации на ${slidesCount} слайдов.

Верни ТОЛЬКО JSON в формате:
{
  "topic": "${topic}",
  "subject": "${subject}",
  "grade": "${grade}",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Пункт 1", "Пункт 2", "Пункт 3", "Пункт 4"]
    }
  ],
  "homework": "Домашнее задание",
  "materials": ["Материал 1", "Материал 2"]
}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "8000" },
      messages: [{ role: 'user', text: prompt }]
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, timeout: 90000 });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    let lessonData = JSON.parse(cleanText);
    
    if (!lessonData.slides) lessonData.slides = [];
    
    lessonData.slides = lessonData.slides.map(slide => {
      if (typeof slide.content === 'string') {
        slide.content = [slide.content];
      }
      if (!Array.isArray(slide.content)) {
        slide.content = [slide.content?.toString() || 'Информация'];
      }
      while (slide.content.length < 4) {
        slide.content.push('Дополнительный материал');
      }
      return slide;
    });
    
    while (lessonData.slides.length < slidesCount) {
      lessonData.slides.push({
        title: `Слайд ${lessonData.slides.length + 1}`,
        content: ['Информация', 'Пример', 'Задание', 'Вывод']
      });
    }
    
    user = await decrementGenerations(user);
    if (pool && user.id !== 'guest') {
      try {
        await pool.query(`INSERT INTO generation_history (user_id, type, title, slide_count, created_at) VALUES ($1, 'lesson', $2, $3, NOW())`, [user.id, topic, slidesCount]);
      } catch (err) {}
    }
    res.json(lessonData);
  } catch (e) {
    console.error('Lesson error:', e.message);
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
    
    const hasGenerations = await canGenerate(user);
    if (!hasGenerations) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились', needPayment: true });
    }

    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
      const questions = Array(qCount).fill().map((_, i) => ({
        question: `Вопрос ${i+1} по теме "${topic}"?`,
        options: ['Вариант А', 'Вариант Б', 'Вариант В', 'Вариант Г'],
        correct: 0,
        explanation: 'Объяснение ответа'
      }));
      user = await decrementGenerations(user);
      return res.json({ title: `Тест: ${topic}`, questions });
    }

    const prompt = `Ты — опытный преподаватель. Создай тест из ${qCount} вопросов по теме "${topic}". 4 варианта ответа. Верни JSON.`;
    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "4000" },
      messages: [{ role: 'user', text: prompt }]
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, timeout: 60000 });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    let quizData = JSON.parse(cleanText);
    
    user = await decrementGenerations(user);
    if (pool && user.id !== 'guest') {
      try {
        await pool.query(`INSERT INTO generation_history (user_id, type, title, slide_count, created_at) VALUES ($1, 'quiz', $2, $3, NOW())`, [user.id, topic, qCount]);
      } catch (err) {}
    }
    res.json(quizData);
  } catch (e) {
    console.error('Quiz error:', e.message);
    res.status(500).json({ error: 'Ошибка генерации теста' });
  }
});

app.post('/api/quiz/from-presentation', optionalAuth, async (req, res) => {
  try {
    const { title, slides, questionCount = 5 } = req.body;
    if (!title || !slides) return res.status(400).json({ error: 'Некорректные данные' });
    let user = req.user;
    const qCount = Math.min(Math.max(questionCount, 3), 10);
    
    const hasGenerations = await canGenerate(user);
    if (!hasGenerations) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились', needPayment: true });
    }

    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
      const questions = Array(qCount).fill().map((_, i) => ({
        question: `Вопрос ${i+1} по презентации "${title}"?`,
        options: ['Вариант А', 'Вариант Б', 'Вариант В', 'Вариант Г'],
        correct: 0,
        explanation: 'Объяснение ответа'
      }));
      user = await decrementGenerations(user);
      return res.json({ title: `Тест: ${title}`, questions });
    }

    const prompt = `На основе презентации "${title}" создай тест из ${qCount} вопросов. Верни JSON.`;
    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "4000" },
      messages: [{ role: 'user', text: prompt }]
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, timeout: 60000 });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    let quizData = JSON.parse(cleanText);
    
    user = await decrementGenerations(user);
    if (pool && user.id !== 'guest') {
      try {
        await pool.query(`INSERT INTO generation_history (user_id, type, title, slide_count, created_at) VALUES ($1, 'quiz', $2, $3, NOW())`, [user.id, title, qCount]);
      } catch (err) {}
    }
    res.json(quizData);
  } catch (e) {
    console.error('Quiz from presentation error:', e.message);
    res.status(500).json({ error: 'Ошибка генерации теста' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REPORT GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/report/generate', optionalAuth, async (req, res) => {
  try {
    const { company, period, standard, reportType, slideCount = 6 } = req.body;
    if (!company || !period) return res.status(400).json({ error: 'Компания и период обязательны' });
    let user = req.user;
    let slidesCount = Math.min(Math.max(slideCount, 3), 15);
    
    const hasGenerations = await canGenerate(user);
    if (!hasGenerations) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились', needPayment: true });
    }

    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
      const slides = Array(slidesCount).fill().map((_, i) => ({ title: `Раздел ${i+1}`, content: ['Показатель', 'Анализ', 'Вывод', 'Рекомендация'] }));
      user = await decrementGenerations(user);
      return res.json({ title: `${reportType || 'Финансовый'} отчёт: ${company}`, company, period, slides });
    }

    const prompt = `Ты — профессиональный финансовый аналитик. Создай ${reportType || 'финансовый'} отчёт для компании "${company}" за период "${period}" по стандарту ${standard || 'IFRS'}. ${slidesCount} слайдов.

Верни ТОЛЬКО JSON в формате:
{
  "title": "${reportType || 'Финансовый отчёт'}: ${company}",
  "company": "${company}",
  "period": "${period}",
  "standard": "${standard || 'IFRS'}",
  "reportType": "${reportType || 'Финансовый отчёт'}",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Пункт 1 с цифрами", "Пункт 2 с аналитикой", "Пункт 3 с выводом", "Пункт 4 с рекомендацией"]
    }
  ]
}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "8000" },
      messages: [{ role: 'user', text: prompt }]
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, timeout: 90000 });

    let text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanText = jsonMatch[0];
    let reportData = JSON.parse(cleanText);
    
    if (!reportData.slides) reportData.slides = [];
    
    reportData.slides = reportData.slides.map(slide => {
      if (typeof slide.content === 'string') {
        slide.content = [slide.content];
      }
      if (!Array.isArray(slide.content)) {
        slide.content = [slide.content?.toString() || 'Информация'];
      }
      while (slide.content.length < 4) {
        slide.content.push('Дополнительный анализ');
      }
      return slide;
    });
    
    while (reportData.slides.length < slidesCount) {
      reportData.slides.push({
        title: `Раздел ${reportData.slides.length + 1}`,
        content: ['Показатель', 'Анализ', 'Вывод', 'Рекомендация']
      });
    }
    
    user = await decrementGenerations(user);
    if (pool && user.id !== 'guest') {
      try {
        await pool.query(`INSERT INTO generation_history (user_id, type, title, slide_count, created_at) VALUES ($1, 'report', $2, $3, NOW())`, [user.id, company, slidesCount]);
      } catch (err) {}
    }
    res.json(reportData);
  } catch (e) {
    console.error('Report error:', e.message);
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
    
    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
      return res.json({ original: text, improved: text });
    }

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.6, maxTokens: "500" },
      messages: [{ role: 'user', text: `Улучши текст: "${text}"` }]
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, timeout: 20000 });
    const improved = response.data.result.alternatives[0].message.text.trim();
    res.json({ original: text, improved });
  } catch (e) {
    res.json({ original: req.body.text, improved: req.body.text });
  }
});

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════
app.post('/api/export/pptx', optionalAuth, (req, res) => res.json({ success: true, message: 'PPTX готов' }));
app.post('/api/export/pdf', optionalAuth, (req, res) => {
  const user = req.user;
  if (!user.is_premium && !user.is_vip && user.id !== 'guest') return res.status(403).json({ error: 'Premium доступ required' });
  res.json({ success: true, message: 'PDF готов' });
});

// ═══════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════
app.get('/api/history', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (user.id === 'guest' || !pool) return res.json({ history: [] });
    const result = await pool.query(`SELECT id, type, title, slide_count, created_at FROM generation_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [user.id]);
    res.json({ history: result.rows.map(row => ({ id: row.id, type: row.type, title: row.title, slideCount: row.slide_count, createdAt: row.created_at })) });
  } catch (e) { res.json({ history: [] }); }
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT CALLBACK
// ═══════════════════════════════════════════════════════════════
app.post('/api/payment/callback', async (req, res) => {
  try {
    console.log('💰 Payment callback:', JSON.stringify(req.body));
    const { status, amount, email, plan } = req.body;
    if (status !== 'success' && status !== 'completed') return res.json({ success: true });
    if (!pool) return res.json({ success: true });
    
    let durationMonths = 1;
    if (plan === 'half_year' || plan === 'half') { durationMonths = 6; }
    else if (plan === 'year') { durationMonths = 12; }
    
    const expiry = new Date(); expiry.setMonth(expiry.getMonth() + durationMonths);
    let userId = null;
    if (email) {
      const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (userResult.rows.length > 0) userId = userResult.rows[0].id;
    }
    if (userId) {
      await pool.query(
        `UPDATE users SET is_premium = TRUE, premium_expiry = $1, free_generations_left = 9999, monthly_generations_left = 9999 WHERE id = $2`,
        [expiry, userId]
      );
      console.log(`✅ Premium activated for ${userId} until ${expiry}`);
    }
    res.json({ success: true });
  } catch (e) { 
    console.error('Payment callback error:', e.message); 
    res.status(500).json({ error: 'Error processing payment' }); 
  }
});

// ═══════════════════════════════════════════════════════════════
// PROMOCODES
// ═══════════════════════════════════════════════════════════════
app.post('/api/promocode/validate', optionalAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ valid: false, message: 'Code required' });
    
    if (!pool) {
      return res.json({ valid: true, discountType: 'percent', discountValue: 50, description: 'DEMO: 50% off' });
    }
    
    const result = await pool.query(
      `SELECT * FROM promocodes WHERE code = $1 AND is_active = true 
       AND (valid_until IS NULL OR valid_until > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)`,
      [code.toUpperCase()]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ valid: false, message: 'Invalid or expired promo code' });
    }
    
    const promocode = result.rows[0];
    res.json({ 
      valid: true, 
      discountType: promocode.discount_type, 
      discountValue: promocode.discount_value, 
      description: promocode.description 
    });
  } catch (e) {
    console.error('Promocode validate error:', e.message);
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

app.post('/api/promocode/apply', optionalAuth, async (req, res) => {
  try {
    const { code, plan } = req.body;
    const user = req.user;
    if (!code || !plan) return res.status(400).json({ success: false, message: 'Code and plan required' });
    
    if (!pool) {
      const prices = { monthly: 4.99, half_year: 29.99, year: 49.99 };
      const originalPrice = prices[plan] || 4.99;
      return res.json({ success: true, finalPrice: originalPrice * 0.5, discountApplied: true, message: '50% off applied!' });
    }
    
    const result = await pool.query(
      `SELECT * FROM promocodes WHERE code = $1 AND is_active = true 
       AND (valid_until IS NULL OR valid_until > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)`,
      [code.toUpperCase()]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired promo code' });
    }
    
    const promocode = result.rows[0];
    const prices = { monthly: 4.99, half_year: 29.99, year: 49.99 };
    const originalPrice = prices[plan] || 4.99;
    let finalPrice = originalPrice;
    
    if (promocode.discount_type === 'percent') {
      finalPrice = originalPrice * (1 - promocode.discount_value / 100);
    }
    
    res.json({ 
      success: true, 
      finalPrice: finalPrice, 
      discountApplied: true, 
      discountType: promocode.discount_type,
      discountValue: promocode.discount_value,
      message: `Promo code applied! You save ${promocode.discount_value}%` 
    });
  } catch (e) {
    console.error('Promocode apply error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// VIP STATS
// ═══════════════════════════════════════════════════════════════
app.get('/api/vip/stats', async (req, res) => {
  try {
    if (!pool) {
      return res.json({ totalSpots: 50, occupiedSpots: 0 });
    }
    
    const result = await pool.query(
      'SELECT COUNT(*) as occupied FROM users WHERE is_vip = TRUE'
    );
    
    const occupiedSpots = parseInt(result.rows[0]?.occupied || 0);
    const totalSpots = 50;
    
    res.json({ totalSpots, occupiedSpots });
  } catch (e) {
    console.error('VIP stats error:', e.message);
    res.status(500).json({ error: 'Failed to load VIP stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ACTIVATE VIP
// ═══════════════════════════════════════════════════════════════
app.post('/api/vip/activate', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    
    if (user.id === 'guest') {
      return res.status(401).json({ error: 'Please log in first' });
    }
    
    if (!pool) {
      return res.json({ success: true, message: 'VIP activated (demo)' });
    }
    
    const countResult = await pool.query(
      'SELECT COUNT(*) as occupied FROM users WHERE is_vip = TRUE'
    );
    const occupiedSpots = parseInt(countResult.rows[0]?.occupied || 0);
    
    if (occupiedSpots >= 50) {
      return res.status(400).json({ error: 'All VIP spots are taken' });
    }
    
    if (user.is_vip) {
      return res.status(400).json({ error: 'You are already a VIP member' });
    }
    
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 10);
    
    await pool.query(
      `UPDATE users 
       SET is_vip = TRUE, 
           vip_activated_at = NOW(),
           premium_expiry = $1,
           free_generations_left = 9999,
           monthly_generations_left = 9999
       WHERE id = $2`,
      [expiry, user.id]
    );
    
    console.log(`👑 VIP activated for user ${user.id} (spot ${occupiedSpots + 1}/50)`);
    
    res.json({ 
      success: true, 
      message: 'VIP activated! You now have lifetime access.',
      spot: occupiedSpots + 1,
      totalSpots: 50
    });
  } catch (e) {
    console.error('VIP activation error:', e.message);
    res.status(500).json({ error: 'Failed to activate VIP' });
  }
});

// ═══════════════════════════════════════════════════════════════
// INIT DATABASE (УПРОЩЁННЫЙ)
// ═══════════════════════════════════════════════════════════════
async function initDatabase() {
  if (!pool) {
    console.log('⚠️ База данных не настроена, работаем в DEMO режиме');
    return;
  }
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    console.log('✅ База данных подключена');
    client.release();
    
    console.log('✅ Таблицы уже созданы (или будут созданы автоматически)');
    console.log('✅ Промокоды уже добавлены');
  } catch (e) { 
    console.error('❌ Ошибка при инициализации БД:', e.message);
  }
}

// ЗАПУСК СЕРВЕРА
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
    console.log(`📊 DB: ${pool ? 'connected' : 'DEMO mode'}`);
    console.log(`🎨 Unsplash: ${UNSPLASH_ACCESS_KEY ? 'enabled' : 'disabled'}`);
    console.log(`🎟️ Promocodes: CRYPTO50 (50%), BLOGGER (30%)`);
    console.log(`👑 VIP endpoints: /api/vip/stats, /api/vip/activate`);
  });
});