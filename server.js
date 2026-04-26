const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const morgan = require('morgan');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ЗАЩИТА =====

// Helmet — защита HTTP-заголовков
app.use(helmet());

// CORS — только с нашего домена
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5000',
    'https://prezentator-ai.com',
    'https://maximzhankevich1993.github.io',
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Доступ запрещён'));
        }
    },
    credentials: true,
}));

// Rate Limiting — защита от DDoS и брутфорса
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // максимум 100 запросов
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5, // 5 попыток входа
    message: { error: 'Слишком много попыток входа. Подождите 15 минут.' },
});

const generateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 3, // 3 генерации в минуту
    message: { error: 'Слишком много генераций. Подождите минуту.' },
});

app.use(generalLimiter);

// Логирование запросов
app.use(morgan('combined'));

// Парсинг JSON с ограничением размера
app.use(express.json({ limit: '1mb' }));

// ===== ВАЛИДАЦИЯ ВХОДНЫХ ДАННЫХ =====

const sanitizeInput = (value) => {
    if (typeof value !== 'string') return value;
    return value
        .replace(/<[^>]*>/g, '') // Убираем HTML-теги
        .replace(/['"`;]/g, '')   // Убираем кавычки и точку с запятой
        .trim()
        .substring(0, 1000);      // Ограничиваем длину
};

const validateGenerate = [
    body('topic')
        .isString()
        .trim()
        .isLength({ min: 3, max: 500 })
        .withMessage('Тема должна быть от 3 до 500 символов')
        .customSanitizer(sanitizeInput),
    body('maxSlides')
        .optional()
        .isInt({ min: 1, max: 50 })
        .withMessage('Количество слайдов: от 1 до 50'),
];

const validateRegister = [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Некорректный email'),
    body('password')
        .isLength({ min: 8, max: 100 })
        .withMessage('Пароль должен быть от 8 до 100 символов')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Пароль должен содержать заглавную, строчную букву и цифру'),
    body('name')
        .optional()
        .isString()
        .trim()
        .isLength({ max: 100 })
        .customSanitizer(sanitizeInput),
];

// ===== JWT АУТЕНТИФИКАЦИЯ =====

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        req.user = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Недействительный токен' });
    }
};

// ===== API РОУТЫ =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        security: {
            helmet: true,
            rateLimit: true,
            cors: true,
            validation: true,
        }
    });
});

// Генерация презентации (с защитой)
app.post('/api/generate', generateLimiter, validateGenerate, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { topic, maxSlides = 10 } = req.body;
        
        console.log(`Генерация: "${topic}"`);
        
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: getSystemPrompt() },
                    { role: 'user', content: buildPrompt(topic, maxSlides) }
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

// Регистрация
app.post('/api/register', authLimiter, validateRegister, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password, name } = req.body;
        
        // Хешируем пароль
        const salt = await bcrypt.genSalt(12);
        const passwordHash = await bcrypt.hash(password, salt);
        
        // TODO: сохранить в базу данных
        console.log(`Регистрация: ${email}`);
        
        res.status(201).json({
            message: 'Пользователь зарегистрирован',
            email: email,
        });
        
    } catch (error) {
        console.error('Ошибка регистрации:', error.message);
        res.status(500).json({ error: 'Ошибка регистрации' });
    }
});

// Вход
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // TODO: проверить пользователя в базе данных
        
        // Создаём JWT токен
        const token = jwt.sign(
            { email: email },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '24h' }
        );
        
        res.json({ token, expiresIn: '24h' });
        
    } catch (error) {
        console.error('Ошибка входа:', error.message);
        res.status(500).json({ error: 'Ошибка входа' });
    }
});

// Защищённый маршрут (пример)
app.get('/api/me', authenticate, (req, res) => {
    res.json({
        user: req.user,
        message: 'Доступ разрешён'
    });
});

// Поиск картинок
app.post('/api/images/search', async (req, res) => {
    try {
        const { keywords, count = 5 } = req.body;
        
        if (!keywords || keywords.length < 2) {
            return res.status(400).json({ error: 'Ключевые слова не указаны' });
        }
        
        const response = await axios.get('https://api.unsplash.com/search/photos', {
            params: {
                query: sanitizeInput(keywords),
                per_page: Math.min(count, 10),
                orientation: 'landscape',
                client_id: process.env.UNSPLASH_ACCESS_KEY
            },
            timeout: 10000
        });
        
        const images = response.data.results.map(img => img.urls.regular);
        res.json({ images, keywords: sanitizeInput(keywords) });
        
    } catch (error) {
        console.error('Ошибка поиска:', error.message);
        res.status(500).json({ error: 'Ошибка поиска картинок' });
    }
});

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function getSystemPrompt() {
    return `Ты — эксперт по созданию презентаций. Создай структуру в формате JSON.

Правила:
1. Каждый слайд имеет заголовок
2. Содержание — 3-5 пунктов
3. Для каждого слайда — ключевые слова для поиска картинки (на английском)
4. Слайды логически связаны

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

function buildPrompt(topic, maxSlides) {
    return `Создай структуру презентации на тему: "${topic}"

Требования:
- Количество слайдов: ровно ${maxSlides}
- Первый слайд: заголовок и введение
- Последний слайд: заключение
- Для каждого слайда укажи ключевые слова для поиска картинки на английском`;
}

// ===== ОБРАБОТКА ОШИБОК =====

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Внутренняя ошибка сервера',
        requestId: require('uuid').v4(),
    });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Маршрут не найден' });
});

// ===== ЗАПУСК СЕРВЕРА =====

app.listen(PORT, () => {
    console.log(`🔒 Защищённый сервер запущен: http://localhost:${PORT}`);
    console.log(`📊 Health: http://localhost:${PORT}/api/health`);
    console.log('🛡 Защита: Helmet + Rate Limit + CORS + Валидация + JWT');
});