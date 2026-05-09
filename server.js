const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '1mb' }));

// Используем переменные окружения или твои прямые ключи
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || 'ajencn3d4uu50ovbhb05';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || 'b1gi8mre52qd4eknmlbc';
const YANDEX_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '6.0.0', api: 'YandexGPT' });
});

app.post('/api/generate', async (req, res) => {
  try {
    const { topic, maxSlides = 5 } = req.body;
    
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    console.log(`Генерация (YandexGPT): "${topic}"`);

    const prompt = `Создай структуру презентации на тему: "${topic}". Количество слайдов: ${maxSlides}.

Верни ТОЛЬКО валидный JSON. Формат:
{
  "title": "Название презентации",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Пункт 1", "Пункт 2", "Пункт 3"]
    }
  ]
}`;

    const response = await axios.post(
      YANDEX_URL,
      {
        modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt/latest`,
        completionOptions: { stream: false, temperature: 0.7, maxTokens: "2000" },
        messages: [{ role: 'user', text: prompt }]
      },
      { 
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Api-Key ${YANDEX_API_KEY}` 
        }, 
        timeout: 30000 
      }
    );

    const text = response.data.result.alternatives[0].message.text;
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    
    const presentation = JSON.parse(cleanText);
    
    console.log(`Сгенерировано ${presentation.slides?.length || 0} слайдов`);
    res.json(presentation);

  } catch (error) {
    console.error('Ошибка YandexGPT:', error.message);
    if (error.response) console.error('Ответ:', JSON.stringify(error.response.data).substring(0, 500));
    
    // Fallback: тестовая генерация
    const slides = [];
    for (let i = 0; i < 5; i++) {
      slides.push({
        title: i === 0 ? req.body.topic : `${req.body.topic} — часть ${i + 1}`,
        content: [
          `Ключевой пункт ${i * 3 + 1}`,
          `Ключевой пункт ${i * 3 + 2}`,
          `Ключевой пункт ${i * 3 + 3}`
        ]
      });
    }
    console.log(`Fallback: сгенерировано ${slides.length} слайдов`);
    res.json({ title: req.body.topic, slides });
  }
});

app.post('/api/images/search', async (req, res) => {
  res.json({ images: [], keywords: req.body.keywords, placeholder: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер YandexGPT: http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
});