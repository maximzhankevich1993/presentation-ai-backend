const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '1mb' }));

// Кодировка UTF-8 для всех ответов
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Cohere API
const COHERE_API_KEY = 'cohere_2tieM0pkzVnWwCshDTC8Jw1QJtSatDjh60k3Uamx0YB9aP';
const COHERE_URL = 'https://api.cohere.ai/v2/chat';

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '5.0.0', api: 'Cohere' });
});

// Генерация презентации
app.post('/api/generate', async (req, res) => {
  try {
    const { topic, maxSlides = 5 } = req.body;
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    console.log(`Генерация (Cohere): "${topic}"`);

    const prompt = `Создай структуру презентации на тему: "${topic}". Количество слайдов: ${maxSlides}.

Верни ТОЛЬКО валидный JSON, без markdown и лишнего текста. Формат:
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
      COHERE_URL,
      {
        model: 'command',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 2000
      },
      {
        headers: {
          'Authorization': `Bearer ${COHERE_API_KEY}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json; charset=utf-8',
          'Accept-Charset': 'utf-8'
        },
        timeout: 30000
      }
    );

    const text = response.data.message?.content?.text || response.data.text || '';
    let cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    
    const presentation = JSON.parse(cleanText);
    console.log(`Сгенерировано ${presentation.slides?.length || 0} слайдов`);
    res.json(presentation);

  } catch (error) {
    console.error('Ошибка:', error.message);
    // Fallback: тестовая генерация
    const slides = [];
    for (let i = 0; i < 5; i++) {
      slides.push({
        title: i === 0 ? req.body.topic : `${req.body.topic} — часть ${i + 1}`,
        content: [`Пункт ${i * 3 + 1}`, `Пункт ${i * 3 + 2}`, `Пункт ${i * 3 + 3}`]
      });
    }
    res.json({ title: req.body.topic, slides });
  }
});

// Поиск картинок
app.post('/api/images/search', async (req, res) => {
  res.json({ images: [], keywords: req.body.keywords, placeholder: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер Cohere: http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
});