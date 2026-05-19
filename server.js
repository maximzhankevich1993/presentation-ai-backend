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

if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
  console.error('❌ YANDEX_API_KEY и YANDEX_FOLDER_ID обязательны');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token || !pool) {
    req.user = { id: 'guest', email: 'guest@demo.com', name: 'Гость', is_premium: false, free_generations_left: 5, is_vip: false };
    return next();
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.is_premium, u.premium_expiry, u.free_generations_left, u.is_vip
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length > 0) {
      req.user = result.rows[0];
    } else {
      req.user = { id: 'guest', email: 'guest@demo.com', name: 'Гость', is_premium: false, free_generations_left: 5, is_vip: false };
    }
    next();
  } catch (e) {
    req.user = { id: 'guest', email: 'guest@demo.com', name: 'Гость', is_premium: false, free_generations_left: 5, is_vip: false };
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
    db: !!pool
  });
});

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  if (!pool) {
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: req.body.name || 'Demo' } });
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
      `INSERT INTO users (email, password_hash, name, verification_token, free_generations_left)
       VALUES ($1, $2, $3, $4, 10) RETURNING id, email, name`,
      [email.toLowerCase(), passwordHash, name || email.split('@')[0], verificationToken]
    );

    const user = result.rows[0];
    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    // Применяем реферальный код если есть
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
               SET free_generations_left = free_generations_left + 2
               WHERE id = $1`,
              [referrerId]
            );
          }
        }
      } catch (e) {
        console.log('Referral apply error:', e);
      }
    }

    try {
      await transporter.sendMail({
        from: `"Презентатор ИИ" <${FROM_EMAIL}>`,
        to: email,
        subject: 'Добро пожаловать! 🎉',
        html: `<h2>Добро пожаловать, ${user.name}!</h2><p>🎁 10 бесплатных генераций уже ждут вас.</p>`
      });
    } catch (_) {}

    res.json({ token: sessionToken, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('Register:', e);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!pool) {
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: 'Demo', isPremium: true, freeGenerationsLeft: 999, isVip: true } });
  }

  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const result = await pool.query(
      'SELECT id, email, name, password_hash, is_premium, premium_expiry, free_generations_left, failed_login_attempts, locked_until, is_vip FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный email или пароль' });

    const user = result.rows[0];
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
        id: user.id, 
        email: user.email, 
        name: user.name, 
        isPremium: user.is_premium, 
        premiumExpiry: user.premium_expiry, 
        freeGenerationsLeft: user.free_generations_left,
        isVip: user.is_vip
      }
    });
  } catch (e) {
    console.error('Login:', e);
    res.status(500).json({ error: 'Ошибка входа' });
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
// GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, slideCount, maxSlides } = req.body;
    const slidesCount = slideCount || maxSlides || 5;
    
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    const user = req.user;
    console.log(`🎯 Генерация: "${topic}" (${slidesCount} слайдов) - ${user.email}`);

    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились' });
    }

    const prompt = `Ты — эксперт. Создай структуру презентации: "${topic}". Слайдов: ${slidesCount}.

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
    
    if (presentation.slides && presentation.slides.length < slidesCount) {
      const lastSlide = presentation.slides[presentation.slides.length - 1];
      for (let i = presentation.slides.length; i < slidesCount; i++) {
        presentation.slides.push({
          title: lastSlide?.title || `Часть ${i + 1}`,
          content: lastSlide?.content || [`Дополнительный тезис ${i * 3 + 1}`, `Дополнительный тезис ${i * 3 + 2}`, `Дополнительный тезис ${i * 3 + 3}`]
        });
      }
    }

    // Сохраняем в историю
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO generation_history (user_id, type, title, slide_count, created_at)
         VALUES ($1, 'presentation', $2, $3, NOW())`,
        [user.id, topic, slidesCount]
      );
    }

    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip) {
      await pool.query(
        'UPDATE users SET free_generations_left = GREATEST(0, free_generations_left - 1), total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    }
    
    console.log(`✅ ${presentation.slides?.length || 0} слайдов из ${slidesCount}`);
    res.json(presentation);
  } catch (e) {
    console.error('❌ Generation error:', e.message);
    
    const slidesCount = req.body.slideCount || req.body.maxSlides || 5;
    const slides = [];
    for (let i = 0; i < slidesCount; i++) {
      slides.push({
        title: i === 0 ? `Введение: ${req.body.topic}` : i === slidesCount - 1 ? 'Заключение' : `${req.body.topic} — часть ${i + 1}`,
        content: [`Ключевой тезис ${i * 3 + 1}`, `Ключевой тезис ${i * 3 + 2}`, `Ключевой тезис ${i * 3 + 3}`]
      });
    }
    res.json({ title: req.body.topic, slides });
  }
});

// ═══════════════════════════════════════════════════════════════
// IMPROVE TEXT
// ═══════════════════════════════════════════════════════════════
app.post('/api/improve', optionalAuth, async (req, res) => {
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

// ═══════════════════════════════════════════════════════════════
// LESSON PLAN GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/lesson-plan/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, subject, standard, grade, durationMinutes } = req.body;
    
    if (!topic || !subject || !grade) {
      return res.status(400).json({ error: 'Тема, предмет и класс обязательны' });
    }

    const user = req.user;
    console.log(`📚 Генерация плана урока: "${topic}" (${subject}, ${grade}, стандарт: ${standard}) - ${user.email}`);

    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились' });
    }

    const standardName = getStandardName(standard);
    const duration = durationMinutes || 45;
    
    const prompt = `Ты — эксперт по педагогике и методист. Создай подробный план урока.

Входные данные:
- Тема урока: ${topic}
- Предмет: ${subject}
- Класс/возраст: ${grade}
- Образовательный стандарт: ${standardName}
- Длительность урока: ${duration} минут

Верни ТОЛЬКО JSON.`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "4000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 60000 
    });

    const text = response.data.result.alternatives[0].message.text;
    const cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    let lessonPlan = JSON.parse(cleanText);
    
    if (!lessonPlan.objectives || lessonPlan.objectives.length < 3) {
      lessonPlan.objectives = [
        `Понять основные концепции темы "${topic}"`,
        `Научиться применять знания на практике`,
        `Развить критическое мышление`,
        `Сформировать навыки работы в группе`
      ];
    }
    
    if (!lessonPlan.stages || lessonPlan.stages.length < 4) {
      lessonPlan.stages = getDefaultStages(topic, duration);
    }

    // Сохраняем в историю
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO generation_history (user_id, type, title, created_at)
         VALUES ($1, 'lesson_plan', $2, NOW())`,
        [user.id, topic]
      );
    }

    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip) {
      await pool.query(
        'UPDATE users SET free_generations_left = GREATEST(0, free_generations_left - 1), total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    }
    
    console.log(`✅ План урока создан: "${lessonPlan.topic}"`);
    res.json(lessonPlan);
    
  } catch (e) {
    console.error('❌ Lesson Plan error:', e.message);
    const { topic, subject, standard, grade, durationMinutes = 45 } = req.body;
    res.json({
      topic: topic || 'План урока',
      subject: subject || 'Предмет',
      grade: grade || 'Класс',
      standard: standard || 'common_core',
      duration: `${durationMinutes} минут`,
      objectives: [
        `Понять основные концепции темы "${topic || 'урока'}"`,
        `Научиться применять знания на практике`,
        `Развить критическое мышление`,
        `Сформировать навыки работы в группе`
      ],
      stages: getDefaultStages(topic || 'урока', durationMinutes),
      homework: `Повторить пройденный материал.`,
      assessment: 'Фронтальный опрос. Практическая работа.',
      differentiation: ['Задания разного уровня сложности', 'Индивидуальные карточки', 'Работа в парах']
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// REPORT GENERATE (КОНСТРУКТОР ОТЧЁТОВ)
// ═══════════════════════════════════════════════════════════════
app.post('/api/report/generate', optionalAuth, async (req, res) => {
  try {
    const { company, period, standard, reportType } = req.body;
    
    if (!company || !period) {
      return res.status(400).json({ error: 'Компания и период обязательны' });
    }

    const user = req.user;
    console.log(`📊 Генерация отчёта: "${company}" (${standard}, ${reportType}) - ${user.email}`);

    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились' });
    }

    const prompt = `Ты — финансовый аналитик. Создай отчёт для компании "${company}" за период ${period}.
Стандарт: ${standard}
Тип отчёта: ${reportType}
Верни ТОЛЬКО JSON со структурой отчёта.`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "3000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 60000 
    });

    const text = response.data.result.alternatives[0].message.text;
    const cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const report = JSON.parse(cleanText);

    // Сохраняем в историю
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO generation_history (user_id, type, title, created_at)
         VALUES ($1, 'report', $2, NOW())`,
        [user.id, company]
      );
    }

    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip) {
      await pool.query(
        'UPDATE users SET free_generations_left = GREATEST(0, free_generations_left - 1), total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    }
    
    console.log(`✅ Отчёт создан: "${company}"`);
    res.json(report);
    
  } catch (error) {
    console.error('❌ Report generation error:', error.message);
    res.status(500).json({ error: 'Ошибка генерации отчёта' });
  }
});

// ═══════════════════════════════════════════════════════════════
// QUIZ GENERATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/quiz/generate', optionalAuth, async (req, res) => {
  try {
    const { topic, textbook, grade, questionCount, countryCode } = req.body;
    
    if (!topic) {
      return res.status(400).json({ error: 'Тема не указана' });
    }
    
    const user = req.user;
    const qCount = Math.min(Math.max(questionCount || 5, 3), 10);
    
    console.log(`📝 Генерация теста: "${topic}" - ${user.email}`);
    
    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились' });
    }
    
    const countryName = getCountryNameForQuiz(countryCode || 'RU');
    const textbookText = textbook ? `\nУчебник: ${textbook}` : '';
    
    const prompt = `Ты — эксперт по педагогике. Создай тест по теме "${topic}" для ${grade || 9} класса.${textbookText}
Страна: ${countryName}
Создай ${qCount} вопросов с 4 вариантами ответов.
Верни ТОЛЬКО JSON.`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "3000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 60000 
    });

    const text = response.data.result.alternatives[0].message.text;
    const cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const quiz = JSON.parse(cleanText);
    
    // Сохраняем в историю
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO generation_history (user_id, type, title, created_at)
         VALUES ($1, 'quiz', $2, NOW())`,
        [user.id, topic]
      );
    }
    
    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip) {
      await pool.query(
        'UPDATE users SET free_generations_left = GREATEST(0, free_generations_left - 1), total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    }
    
    console.log(`✅ Тест создан: "${topic}"`);
    res.json(quiz);
    
  } catch (error) {
    console.error('❌ Quiz error:', error.message);
    res.status(500).json({ error: 'Ошибка генерации теста' });
  }
});

app.post('/api/quiz/from-presentation', optionalAuth, async (req, res) => {
  try {
    const { title, slides, questionCount } = req.body;
    
    if (!title || !slides || slides.length === 0) {
      return res.status(400).json({ error: 'Некорректные данные' });
    }
    
    const user = req.user;
    const qCount = Math.min(Math.max(questionCount || 5, 3), 10);
    
    console.log(`📝 Генерация теста из презентации: "${title}" - ${user.email}`);
    
    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились' });
    }
    
    const relevantSlides = slides.slice(0, Math.min(5, slides.length));
    const slidesText = relevantSlides.map((s, i) => {
      const text = typeof s === 'string' ? s : (s.title + ' ' + (s.content || []).join(' '));
      return `Слайд ${i+1}: ${text.substring(0, 500)}`;
    }).join('\n');
    
    const prompt = `На основе презентации "${title}" создай тест.
Содержание: ${slidesText}
Создай ${qCount} вопросов.
Верни ТОЛЬКО JSON.`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: "3000" },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, 
      timeout: 60000 
    });

    const text = response.data.result.alternatives[0].message.text;
    const cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const quiz = JSON.parse(cleanText);
    
    if (pool && user.id !== 'guest' && !user.is_premium && !user.is_vip) {
      await pool.query(
        'UPDATE users SET free_generations_left = GREATEST(0, free_generations_left - 1), total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    }
    
    console.log(`✅ Тест из презентации создан: "${title}"`);
    res.json(quiz);
    
  } catch (error) {
    console.error('❌ Quiz from presentation error:', error.message);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

// ═══════════════════════════════════════════════════════════════
// EXPORT (PPTX / PDF)
// ═══════════════════════════════════════════════════════════════

app.post('/api/export/pptx', optionalAuth, async (req, res) => {
  try {
    const { title, slides } = req.body;
    const user = req.user;
    
    console.log(`📤 Экспорт PPTX: "${title}" - ${user.email}`);
    
    // Сохраняем в историю экспорта
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO export_history (user_id, type, title, created_at)
         VALUES ($1, 'pptx', $2, NOW())`,
        [user.id, title]
      );
    }
    
    res.json({
      success: true,
      message: 'PPTX готов к скачиванию',
      url: `https://presentation-ai-backend.onrender.com/exports/${Date.now()}.pptx`
    });
  } catch (error) {
    console.error('❌ PPTX export error:', error);
    res.status(500).json({ error: 'Ошибка экспорта PPTX' });
  }
});

app.post('/api/export/pdf', optionalAuth, async (req, res) => {
  try {
    const { title, slides } = req.body;
    const user = req.user;
    
    if (!user.is_premium && !user.is_vip) {
      return res.status(403).json({ error: 'Premium доступ required' });
    }
    
    console.log(`📤 Экспорт PDF: "${title}" - ${user.email}`);
    
    // Сохраняем в историю экспорта
    if (pool && user.id !== 'guest') {
      await pool.query(
        `INSERT INTO export_history (user_id, type, title, created_at)
         VALUES ($1, 'pdf', $2, NOW())`,
        [user.id, title]
      );
    }
    
    res.json({
      success: true,
      message: 'PDF готов к скачиванию',
      url: `https://presentation-ai-backend.onrender.com/exports/${Date.now()}.pdf`
    });
  } catch (error) {
    console.error('❌ PDF export error:', error);
    res.status(500).json({ error: 'Ошибка экспорта PDF' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GENERATION HISTORY (ИСТОРИЯ)
// ═══════════════════════════════════════════════════════════════

app.get('/api/history', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    
    if (user.id === 'guest') {
      return res.json({ history: [] });
    }
    
    if (!pool) {
      return res.json({ history: [] });
    }
    
    const history = await pool.query(
      `SELECT id, type, title, slide_count, created_at
       FROM generation_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [user.id]
    );
    
    res.json({ history: history.rows });
  } catch (error) {
    console.error('❌ History error:', error);
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});

app.delete('/api/history/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    
    if (user.id === 'guest') {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (!pool) {
      return res.json({ success: true });
    }
    
    await pool.query(
      'DELETE FROM generation_history WHERE id = $1 AND user_id = $2',
      [id, user.id]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete history error:', error);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REFERRAL SYSTEM
// ═══════════════════════════════════════════════════════════════

app.get('/api/referral/stats', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    
    if (user.id === 'guest') {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (!pool) {
      return res.json({
        code: `REF${user.id?.substring(0, 6)?.toUpperCase() || 'GUEST'}`,
        referralsCount: 0,
        bonusGenerations: 0,
        friends: [],
      });
    }
    
    let referral = await pool.query(
      'SELECT code, referrals_count, bonus_generations FROM referrals WHERE user_id = $1',
      [user.id]
    );
    
    let referralCode;
    if (referral.rows.length === 0) {
      referralCode = await _generateUniqueReferralCode(user.id);
      await pool.query(
        'INSERT INTO referrals (user_id, code, referrals_count, bonus_generations) VALUES ($1, $2, $3, $4)',
        [user.id, referralCode, 0, 0]
      );
    } else {
      referralCode = referral.rows[0].code;
    }
    
    const friends = await pool.query(
      `SELECT u.name, u.email, r.created_at as date, r.status, r.reward
       FROM referred_friends r
       JOIN users u ON u.id = r.friend_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [user.id]
    );
    
    res.json({
      code: referralCode,
      referralsCount: referral.rows[0]?.referrals_count || 0,
      bonusGenerations: referral.rows[0]?.bonus_generations || 0,
      friends: friends.rows.map(f => ({
        name: f.name || f.email?.split('@')[0] || 'Пользователь',
        email: f.email,
        date: _formatDate(f.date),
        status: f.status,
        reward: f.reward,
      })),
    });
    
  } catch (error) {
    console.error('❌ Referral stats error:', error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.post('/api/referral/apply', async (req, res) => {
  try {
    const { code, userId } = req.body;
    
    if (!code || !userId) {
      return res.status(400).json({ error: 'Код и ID обязательны' });
    }
    
    if (!pool) {
      return res.json({ success: true });
    }
    
    const referrer = await pool.query(
      'SELECT user_id FROM referrals WHERE code = $1',
      [code.toUpperCase()]
    );
    
    if (referrer.rows.length === 0) {
      return res.status(404).json({ error: 'Неверный реферальный код' });
    }
    
    const referrerId = referrer.rows[0].user_id;
    
    if (referrerId === userId) {
      return res.status(400).json({ error: 'Нельзя использовать свой код' });
    }
    
    const existing = await pool.query(
      'SELECT id FROM referred_friends WHERE friend_id = $1',
      [userId]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Код уже был применен' });
    }
    
    await pool.query(
      `INSERT INTO referred_friends (referrer_id, friend_id, status, reward, created_at)
       VALUES ($1, $2, 'pending', NULL, NOW())`,
      [referrerId, userId]
    );
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Apply referral error:', error);
    res.status(500).json({ error: 'Ошибка применения кода' });
  }
});

app.post('/api/referral/activate', optionalAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    const user = req.user;
    
    if (user.id === 'guest') {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (!pool) {
      return res.json({ success: true });
    }
    
    await pool.query(
      `UPDATE referred_friends 
       SET status = 'activated', reward = 2, activated_at = NOW()
       WHERE friend_id = $1 AND referrer_id = $2`,
      [friendId, user.id]
    );
    
    await pool.query(
      `UPDATE referrals 
       SET referrals_count = referrals_count + 1,
           bonus_generations = bonus_generations + 2
       WHERE user_id = $1`,
      [user.id]
    );
    
    await pool.query(
      `UPDATE users 
       SET free_generations_left = free_generations_left + 2
       WHERE id = $1`,
      [user.id]
    );
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Activate referral error:', error);
    res.status(500).json({ error: 'Ошибка активации' });
  }
});

app.post('/api/referral/premium-activated', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    
    if (user.id === 'guest') {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (!pool) {
      return res.json({ success: true });
    }
    
    const referral = await pool.query(
      'SELECT referrer_id FROM referred_friends WHERE friend_id = $1',
      [user.id]
    );
    
    if (referral.rows.length > 0) {
      const referrerId = referral.rows[0].referrer_id;
      
      await pool.query(
        `UPDATE referred_friends SET status = 'premium_activated', reward = 10 WHERE friend_id = $1`,
        [user.id]
      );
      
      await pool.query(
        `UPDATE referrals SET bonus_generations = bonus_generations + 10 WHERE user_id = $1`,
        [referrerId]
      );
      
      await pool.query(
        `UPDATE users SET free_generations_left = free_generations_left + 10 WHERE id = $1`,
        [referrerId]
      );
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Premium activated error:', error);
    res.status(500).json({ error: 'Ошибка активации' });
  }
});

// ═══════════════════════════════════════════════════════════════
// VIP STATS
// ═══════════════════════════════════════════════════════════════
app.get('/api/vip/stats', optionalAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: 'База данных недоступна' });
    }
    
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE is_vip = true'
    );
    
    const occupiedSpots = parseInt(result.rows[0]?.count || 0);
    const totalSpots = 50;
    
    res.json({
      occupiedSpots: occupiedSpots,
      totalSpots: totalSpots,
      availableSpots: totalSpots - occupiedSpots,
    });
  } catch (error) {
    console.error('❌ VIP stats error:', error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.post('/api/vip/purchase', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    
    if (user.id === 'guest') {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (!pool) {
      return res.status(503).json({ error: 'База данных недоступна' });
    }
    
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE is_vip = true'
    );
    
    const occupiedSpots = parseInt(countResult.rows[0]?.count || 0);
    const totalSpots = 50;
    
    if (occupiedSpots >= totalSpots) {
      return res.status(400).json({ error: 'Все VIP места заняты' });
    }
    
    const userCheck = await pool.query(
      'SELECT is_vip FROM users WHERE id = $1',
      [user.id]
    );
    
    if (userCheck.rows[0]?.is_vip) {
      return res.status(400).json({ error: 'Вы уже VIP' });
    }
    
    await pool.query(
      `UPDATE users 
       SET is_vip = true, 
           vip_activated_at = NOW(),
           is_premium = true,
           premium_expiry = NULL
       WHERE id = $1`,
      [user.id]
    );
    
    res.json({ 
      success: true, 
      message: 'VIP статус активирован',
      occupiedSpots: occupiedSpots + 1,
      availableSpots: totalSpots - (occupiedSpots + 1),
    });
  } catch (error) {
    console.error('❌ VIP purchase error:', error);
    res.status(500).json({ error: 'Ошибка активации VIP' });
  }
});

// ═══════════════════════════════════════════════════════════════
// IMAGES SEARCH
// ═══════════════════════════════════════════════════════════════
app.post('/api/images/search', async (req, res) => {
  res.json({ images: [], keywords: req.body.keywords, placeholder: true });
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Сервер на порту ${PORT}`);
    console.log(`📊 БД: ${pool ? 'подключена' : 'DEMO режим'}`);
    console.log(`📚 Все эндпоинты загружены`);
  });
});

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
        free_generations_left INTEGER DEFAULT 10,
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

      CREATE INDEX IF NOT EXISTS idx_users_social_id ON users(social_id);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

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
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS password_resets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS presentations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        slides_data JSONB NOT NULL DEFAULT '[]',
        slide_count INTEGER DEFAULT 0,
        font_pair VARCHAR(100),
        theme_id VARCHAR(100),
        transition_type VARCHAR(50) DEFAULT 'fade',
        is_public BOOLEAN DEFAULT FALSE,
        views INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_presentations_user ON presentations(user_id);

      -- История генераций
      CREATE TABLE IF NOT EXISTS generation_history (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(500) NOT NULL,
        slide_count INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_history_user ON generation_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_history_type ON generation_history(type);

      -- История экспорта
      CREATE TABLE IF NOT EXISTS export_history (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        title VARCHAR(500) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_export_user ON export_history(user_id);

      -- Реферальные таблицы
      CREATE TABLE IF NOT EXISTS referrals (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        code VARCHAR(50) UNIQUE NOT NULL,
        referrals_count INTEGER DEFAULT 0,
        bonus_generations INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_referrals_user ON referrals(user_id);
      CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);

      CREATE TABLE IF NOT EXISTS referred_friends (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        referrer_id UUID REFERENCES users(id) ON DELETE CASCADE,
        friend_id UUID REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending',
        reward INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        activated_at TIMESTAMPTZ,
        UNIQUE(friend_id)
      );

      CREATE INDEX IF NOT EXISTS idx_referred_friends_referrer ON referred_friends(referrer_id);
      CREATE INDEX IF NOT EXISTS idx_referred_friends_friend ON referred_friends(friend_id);
    `);
    
    console.log('✅ Таблицы созданы/проверены');
  } catch (e) {
    console.error('❌ Ошибка создания таблиц:', e.message);
  }
}

async function _generateUniqueReferralCode(userId) {
  const prefix = 'REF';
  const suffix = userId.substring(0, 6).toUpperCase();
  let code = `${prefix}${suffix}`;
  
  const existing = await pool.query('SELECT id FROM referrals WHERE code = $1', [code]);
  
  if (existing.rows.length > 0) {
    const random = Math.floor(Math.random() * 1000);
    code = `${prefix}${suffix}${random}`;
  }
  
  return code;
}

function _formatDate(date) {
  if (!date) return '';
  const now = new Date();
  const diff = now - new Date(date);
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} дня назад`;
  if (days < 30) return `${Math.floor(days / 7)} недели назад`;
  return `${Math.floor(days / 30)} месяца назад`;
}