const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Логирование
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ===== API РОУТЫ =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Генерация презентации через DeepSeek
app.post('/api/generate', async (req, res) => {
    try {
        const { topic, maxSlides = 10, language = 'ru' } = req.body;
        
        if (!topic) {
            return res.status(400).json({ error: 'Тема не указана' });
        }
        
        console.log(`Генерация презентации: "${topic}"`);
        
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: getSystemPrompt(language) },
                    { role: 'user', content: buildPrompt(topic, maxSlides, language) }
                ],
                temperature: 0.7,
                max_tokens: 2000,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            }
        );
        
        const data = response.data;
        const content = data.choices[0].message.content;
        const presentation = JSON.parse(content);
        
        presentation.slides = presentation.slides.map((slide) => {
            if (!slide.image_keywords) {
                slide.image_keywords = slide.title.toLowerCase()
                    .replace(/[^\w\s]/g, '')
                    .split(' ')
                    .filter(w => w.length > 3)
                    .slice(0, 3)
                    .join(' ');
            }
            return slide;
        });
        
        console.log(`Сгенерировано ${presentation.slides.length} слайдов`);
        res.json(presentation);
        
    } catch (error) {
        console.error('Ошибка генерации:', error.message);
        res.status(500).json({ error: 'Ошибка генерации презентации' });
    }
});

// Поиск картинок через Unsplash
app.post('/api/images/search', async (req, res) => {
    try {
        const { keywords, count = 5 } = req.body;
        
        if (!keywords) {
            return res.status(400).json({ error: 'Ключевые слова не указаны' });
        }
        
        console.log(`Поиск картинок: "${keywords}"`);
        
        const response = await axios.get('https://api.unsplash.com/search/photos', {
            params: {
                query: keywords,
                per_page: count,
                orientation: 'landscape',
                client_id: process.env.UNSPLASH_ACCESS_KEY
            },
            timeout: 10000
        });
        
        const images = response.data.results.map(img => img.urls.regular);
        res.json({ images, keywords, source: 'unsplash' });
        
    } catch (error) {
        console.error('Ошибка поиска картинок:', error.message);
        const placeholderImages = Array(count).fill(null).map((_, i) => 
            `https://via.placeholder.com/800x600/4F46E5/FFFFFF?text=Slide+${i+1}`
        );
        res.json({ images: placeholderImages, keywords, placeholder: true });
    }
});

// Генерация презентации с картинками (всё в одном)
app.post('/api/generate-with-images', async (req, res) => {
    try {
        const { topic, maxSlides = 10 } = req.body;
        
        // 1. Генерируем структуру
        const genResponse = await axios.post(`http://localhost:${PORT}/api/generate`, 
            { topic, maxSlides },
            { headers: { 'Content-Type': 'application/json' } }
        );
        
        const presentation = genResponse.data;
        
        // 2. Ищем картинки
        for (let i = 0; i < presentation.slides.length; i++) {
            const slide = presentation.slides[i];
            
            if (slide.image_keywords) {
                try {
                    const imgResponse = await axios.post(`http://localhost:${PORT}/api/images/search`,
                        { keywords: slide.image_keywords, count: 1 },
                        { headers: { 'Content-Type': 'application/json' } }
                    );
                    
                    slide.image_url = imgResponse.data.images[0] || null;
                } catch (e) {
                    slide.image_url = null;
                }
            }
            
            // Добавляем фон по умолчанию
            slide.background = { type: 'color', value: '#FFFFFF' };
        }
        
        res.json(presentation);
        
    } catch (error) {
        console.error('Ошибка:', error.message);
        res.status(500).json({ error: 'Ошибка генерации' });
    }
});

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function getSystemPrompt(language) {
    if (language === 'ru') {
        return `Ты — эксперт по созданию презентаций. Создай структуру презентации в формате JSON.

Правила:
1. Каждый слайд имеет заголовок
2. Содержание — 3-5 ключевых пунктов
3. Для каждого слайда укажи ключевые слова для поиска картинки (на английском)
4. Слайды должны быть логически связаны

Формат ответа:
{
  "title": "Заголовок презентации",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Пункт 1", "Пункт 2", "Пункт 3"],
      "image_keywords": "keywords in english"
    }
  ]
}`;
    }
    return `You are an expert presentation creator. Create a presentation structure in JSON format...`;
}

function buildPrompt(topic, maxSlides, language) {
    if (language === 'ru') {
        return `Создай структуру презентации на тему: "${topic}"

Требования:
- Количество слайдов: ровно ${maxSlides}
- Первый слайд: заголовок и введение
- Последний слайд: заключение
- Для каждого слайда укажи ключевые слова для поиска картинки на английском`;
    }
    return `Create a presentation structure on: "${topic}"...`;
}

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});