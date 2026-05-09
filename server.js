const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');

// Загружаем .env для локальной разработки
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ 
  origin: '*', 
  methods: ['GET', 'POST', 'OPTIONS'], 
  allowedHeaders: ['Content-Type', 'Authorization'] 
}));
app.use(express.json({ limit: '1mb' }));

// YandexGPT ключи из окружения
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const YANDEX_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

// Проверка ключей при старте
if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
  console.error('❌ Ошибка: YANDEX_API_KEY и YANDEX_FOLDER_ID обязательны в .env');
  process.exit(1);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    version: '6.0.0', 
    api: 'YandexGPT' 
  });
});

// Генерация презентации
app.post('/api/generate', async (req, res) => {
  try {
    const { topic, maxSlides = 5 } = req.body;
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    console.log(`🎯 Генерация: "${topic}"`);

    const prompt = `Ты — профессиональный дизайнер презентаций. Создай структуру презентации на тему: "${topic}".

Количество слайдов: ${maxSlides}

СТРОГИЕ ПРАВИЛА:
1. Заголовки слайдов — раскрывают суть, НЕ вопросы. 
   ПЛОХО: "Что такое космос?"
   ХОРОШО: "Космос: бескрайние просторы Вселенной"
   ХОРОШО: "Введение в космическую науку"

2. Содержимое — полноценные тезисы, факты, объяснения.
   ПЛОХО: ["Космос", "Планеты", "Звёзды"]
   ХОРОШО: ["Космос включает всё пространство за пределами атмосферы Земли", "Во Вселенной более 100 миллиардов галактик", "Ближайшая звезда — Проксима Центавра, 4.2 световых года"]

3. Структура должна быть логичной:
   - Слайд 1: Введение в тему, определение, значимость
   - Слайд 2-3: Основные факты, ключевая информация
   - Слайд 4: Детали, примеры, применение
   - Слайд 5: Выводы, заключение, перспективы

Верни ТОЛЬКО валидный JSON, без markdown, без обрамления в \`\`\`json. Формат:
{
  "title": "Название презентации",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Содержательный тезис 1", "Содержательный тезис 2", "Содержательный тезис 3"]
    }
  ]
}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { 
        stream: false, 
        temperature: 0.6, 
        maxTokens: "3000" 
      },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Api-Key ${YANDEX_API_KEY}` 
      }, 
      timeout: 45000 
    });

    const text = response.data.result.alternatives[0].message.text;
    const cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const presentation = JSON.parse(cleanText);
    
    console.log(`✅ Сгенерировано ${presentation.slides?.length || 0} слайдов`);
    res.json(presentation);

  } catch (error) {
    console.error('❌ Ошибка генерации:', error.message);
    
    // Fallback
    const slides = [];
    for (let i = 0; i < maxSlides; i++) {
      const slideNumber = i + 1;
      if (slideNumber === 1) {
        slides.push({
          title: `Введение в тему: ${req.body.topic}`,
          content: [`Обзор и ключевые понятия по теме "${req.body.topic}"`, 'Исторический контекст и развитие', 'Почему это важно сегодня']
        });
      } else if (slideNumber === maxSlides) {
        slides.push({
          title: 'Заключение и выводы',
          content: ['Основные выводы по теме', 'Практическое применение', 'Перспективы и будущие направления']
        });
      } else {
        slides.push({
          title: `${req.body.topic} — ключевые аспекты (часть ${slideNumber})`,
          content: [`Факт ${slideNumber * 3 - 2}: Важная информация по теме`, `Факт ${slideNumber * 3 - 1}: Детали и статистика`, `Факт ${slideNumber * 3}: Примеры из практики`]
        });
      }
    }
    res.json({ title: req.body.topic, slides });
  }
});

// Улучшение текста AI
app.post('/api/improve', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Текст не указан' });

    console.log(`✨ Улучшение текста: "${text.substring(0, 50)}..."`);

    const prompt = `Улучши следующий текст для презентации. Сделай его более профессиональным, чётким и убедительным. Сохрани исходный смысл, но улучши стиль и формулировку. Верни ТОЛЬКО улучшенный текст, без пояснений.

Исходный текст: "${text}"

Улучшенный текст:`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { 
        stream: false, 
        temperature: 0.5, 
        maxTokens: "500" 
      },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Api-Key ${YANDEX_API_KEY}` 
      }, 
      timeout: 15000 
    });

    const improvedText = response.data.result.alternatives[0].message.text.trim();
    console.log(`✅ Улучшено: "${improvedText.substring(0, 50)}..."`);
    res.json({ original: text, improved: improvedText });

  } catch (error) {
    console.error('❌ Ошибка улучшения:', error.message);
    res.json({ original: req.body.text, improved: req.body.text });
  }
});

app.post('/api/images/search', async (req, res) => {
  res.json({ images: [], keywords: req.body.keywords, placeholder: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер YandexGPT запущен на порту ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`📝 Generate: POST http://localhost:${PORT}/api/generate`);
  console.log(`✨ Improve: POST http://localhost:${PORT}/api/improve`);
});