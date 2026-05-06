const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

// ✅ Проверка обязательных переменных окружения при старте
const REQUIRED_ENV = ['GEMINI_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Отсутствует обязательная переменная окружения: ${key}`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet());

// ✅ CORS ограничен конкретным доменом (не '*' в продакшене)
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: NODE_ENV === 'production' ? allowedOrigin : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

// ✅ Rate limiting — защита от злоупотреблений
const generateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' },
});

const defaultLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(defaultLimiter);

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/**
 * Извлекает текст из ответа Gemini с валидацией структуры
 * @param {object} responseData — data из axios-ответа
 * @returns {string} — текст из первого кандидата
 * @throws {Error} — если структура ответа неожиданная
 */
function extractGeminiText(responseData) {
  const candidates = responseData?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Gemini вернул пустой список кандидатов');
  }

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Gemini вернул кандидата без контента (возможно, safety filter)');
  }

  const text = parts[0]?.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Gemini вернул пустой текст');
  }

  return text;
}

/**
 * Безопасно парсит JSON из текста Gemini, удаляя markdown-блоки
 * @param {string} text
 * @returns {object}
 * @throws {Error} — если JSON невалидный
 */
function parseGeminiJson(text) {
  const clean = text
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`Gemini вернул невалидный JSON. Начало ответа: ${clean.substring(0, 200)}`);
  }
}

// ─── Роуты ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '3.1.0',
    api: 'Gemini',
    env: NODE_ENV,
  });
});

// ✅ Тестовый эндпоинт — только в режиме разработки
if (NODE_ENV !== 'production') {
  app.get('/api/test-gemini', async (req, res) => {
    try {
      const response = await axios.post(
        `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: 'Say "Hello, World!" in JSON format: {"message": "Hello, World!"}' }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 50 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );

      res.json({ success: true, data: response.data });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        details: error.response?.data || 'No details',
      });
    }
  });
}

// Генерация презентации
app.post('/api/generate', generateLimiter, async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim() === '') {
      return res.status(400).json({ error: 'Тема не указана или имеет неверный формат' });
    }

    // ✅ Валидация и ограничение maxSlides
    const rawMax = parseInt(req.body.maxSlides, 10);
    const maxSlides = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 1), 20) : 10;

    console.log(`Генерация (Gemini): "${topic.trim()}", слайдов: ${maxSlides}`);

    const prompt = `Создай структуру презентации на тему: "${topic.trim()}". Количество слайдов: ${maxSlides}.

Верни ТОЛЬКО JSON-объект в таком формате:
{
  "title": "Заголовок презентации",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Пункт 1", "Пункт 2", "Пункт 3"]
    }
  ]
}`;

    const response = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2000 },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    // ✅ Валидация структуры ответа Gemini
    const text = extractGeminiText(response.data);

    // ✅ Безопасный парсинг JSON
    const presentation = parseGeminiJson(text);

    // ✅ Проверка, что ответ содержит ожидаемые поля
    if (!presentation.title || !Array.isArray(presentation.slides)) {
      return res.status(502).json({ error: 'Gemini вернул презентацию в неожиданном формате' });
    }

    console.log(`Сгенерировано ${presentation.slides.length} слайдов`);
    res.json(presentation);

  } catch (error) {
    console.error('Ошибка /api/generate:', error.message);

    if (error.response) {
      console.error('Gemini ответ:', JSON.stringify(error.response.data).substring(0, 500));
    }

    // ✅ Не отдаём внутренние детали ошибки клиенту в продакшене
    const message = NODE_ENV === 'production'
      ? 'Ошибка генерации презентации'
      : error.message;

    res.status(500).json({ error: message });
  }
});

// Поиск картинок
app.post('/api/images/search', async (req, res) => {
  try {
    const { keywords } = req.body;
    const count = Math.min(parseInt(req.body.count, 10) || 5, 20);

    if (!keywords || typeof keywords !== 'string' || keywords.trim() === '') {
      return res.status(400).json({ error: 'Нет ключевых слов' });
    }

    if (!process.env.UNSPLASH_ACCESS_KEY) {
      console.warn('UNSPLASH_ACCESS_KEY не задан — поиск изображений недоступен');
      return res.json({ images: [], keywords, placeholder: true });
    }

    const response = await axios.get('https://api.unsplash.com/search/photos', {
      params: {
        query: keywords.trim(),
        per_page: count,
        orientation: 'landscape',
        client_id: process.env.UNSPLASH_ACCESS_KEY,
      },
      timeout: 10000,
    });

    const images = response.data.results.map(img => img.urls.regular);
    res.json({ images, keywords });

  } catch (error) {
    // ✅ Логируем ошибку, но не крашим сервер — изображения некритичны
    console.error('Ошибка /api/images/search:', error.message);
    res.json({ images: [], keywords: req.body.keywords, placeholder: true });
  }
});

// ─── 404 и глобальный обработчик ошибок ──────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Эндпоинт не найден' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен [${NODE_ENV}]: http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  if (NODE_ENV !== 'production') {
    console.log(`🧪 Test Gemini: http://localhost:${PORT}/api/test-gemini`);
  }
});