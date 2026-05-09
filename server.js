const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

const COHERE_API_KEY = process.env.COHERE_API_KEY || 'cohere_2tieM0pkzVnWwCshDTC8Jw1QJtSatDjh60k3Uamx0YB9aP';
const PORT = process.env.PORT || 3000;

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', api: 'Cohere', encoding: 'utf-8', timestamp: new Date().toISOString() });
});

// 🔧 Функция: извлечь title/content из текста Cohere
function parseSlides(rawText) {
    const slides = [];
    
    // Убираем ```json ... ``` если есть
    let text = rawText.replace(/```json|```/g, '').trim();
    
    // Разбиваем на строки
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    let currentSlide = null;
    
    for (const line of lines) {
        // Ищем строку с "title": "..."
        const titleMatch = line.match(/"?title"?\s*:\s*"([^"]+)"/);
        if (titleMatch) {
            // Если уже есть накопленный слайд — сохраняем
            if (currentSlide) {
                slides.push(currentSlide);
            }
            currentSlide = { title: titleMatch[1], content: [] };
            continue;
        }
        
        // Ищем строку с "content": "..." или "content": [...]
        const contentStrMatch = line.match(/"?content"?\s*:\s*"([^"]+)"/);
        if (contentStrMatch && currentSlide) {
            currentSlide.content.push(contentStrMatch[1]);
            continue;
        }
        
        // Ищем строку вида "Пункт N" (элемент списка)
        const bulletMatch = line.match(/"?Пункт\s*\d+"?/);
        if (bulletMatch && currentSlide) {
            currentSlide.content.push(line.replace(/^["']|["']$/g, '').replace(/,?\s*$/, ''));
            continue;
        }
        
        // Любая другая строка в кавычках — тоже контент
        const anyStrMatch = line.match(/^"([^"]+)"[,]?$/);
        if (anyStrMatch && currentSlide) {
            currentSlide.content.push(anyStrMatch[1]);
        }
    }
    
    // Добавляем последний слайд
    if (currentSlide) {
        slides.push(currentSlide);
    }
    
    return slides;
}

// Генерация
app.post('/api/generate', async (req, res) => {
    try {
        const { topic, maxSlides = 5, language = 'ru' } = req.body;
        
        if (!topic) {
            return res.status(400).json({ error: 'Укажите topic' });
        }

        console.log(`📝 Генерация: "${topic}" (${maxSlides} слайдов)`);

        // Чёткий промпт для Cohere
        const prompt = `Создай структуру презентации на тему "${topic}" на русском языке.
Формат ответа — ТОЛЬКО JSON (без пояснений):
{
  "slides": [
    {"title": "Заголовок слайда", "content": ["Пункт 1", "Пункт 2", "Пункт 3"]},
    ...
  ]
}
Количество слайдов: ${maxSlides}. Каждый слайд: 2-4 пункта. Пиши ТОЛЬКО JSON. Никакого текста до или после.`;

        const response = await axios.post(
            'https://api.cohere.ai/v1/generate',
            {
                model: 'command',
                prompt: prompt,
                max_tokens: 2000,
                temperature: 0.7,
                k: 0,
                p: 0.75,
                stop_sequences: [],
                return_likelihoods: 'NONE'
            },
            {
                headers: {
                    'Authorization': `Bearer ${COHERE_API_KEY}`,
                    'Content-Type': 'application/json; charset=utf-8'
                },
                timeout: 30000,
                responseType: 'json',
                responseEncoding: 'utf8'
            }
        );

        const rawText = response.data.generations[0].text;
        console.log('📄 Cohere ответ:', rawText.substring(0, 300));

        // Пытаемся распарсить как JSON
        let slides = [];
        try {
            const parsed = JSON.parse(rawText);
            slides = parsed.slides || [];
        } catch (jsonError) {
            console.log('⚠️ JSON битый, парсим вручную...');
            slides = parseSlides(rawText);
        }

        // Если пусто — возвращаем заглушку
        if (slides.length === 0) {
            slides = [
                { title: topic, content: ['Введение', 'Основная часть', 'Заключение'] }
            ];
        }

        console.log(`✅ Слайдов: ${slides.length}`);

        res.json({
            success: true,
            topic: topic,
            slides: slides,
            count: slides.length
        });

    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        res.status(500).json({ 
            error: 'Ошибка генерации',
            details: error.message 
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер на порту ${PORT}`);
});