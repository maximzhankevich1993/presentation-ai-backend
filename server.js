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

    const prompt = `Создай структуру презентации на тему: "${topic}". Количество слайдов: ${maxSlides}.

Верни ТОЛЬКО валидный JSON, без markdown. Формат:
{
  "title": "Название",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Пункт 1", "Пункт 2", "Пункт 3"]
    }
  ]
}`;

    const response = await axios.post(YANDEX_URL, {
      modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { 
        stream: false, 
        temperature: 0.7, 
        maxTokens: "2000" 
      },
      messages: [{ role: 'user', text: prompt }]
    }, { 
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Api-Key ${YANDEX_API_KEY}` 
      }, 
      timeout: 30000 
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
      slides.push({
        title: i === 0 ? req.body.topic : `${req.body.topic} — слайд ${i + 1}`,
        content: [`Пункт ${i * 3 + 1}`, `Пункт ${i * 3 + 2}`, `Пункт ${i * 3 + 3}`]
      });
    }
    res.json({ title: req.body.topic, slides });
  }
});

app.post('/api/images/search', async (req, res) => {
  res.json({ images: [], keywords: req.body.keywords, placeholder: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер YandexGPT запущен на порту ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
});