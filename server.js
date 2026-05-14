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
// AUTO-CREATE TABLES
// ═══════════════════════════════════════════════════════════════
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
        avatar_url TEXT
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

      CREATE TABLE IF NOT EXISTS templates (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100) NOT NULL,
        color1 VARCHAR(7),
        color2 VARCHAR(7),
        slide_count INTEGER DEFAULT 1,
        is_premium BOOLEAN DEFAULT false,
        is_popular BOOLEAN DEFAULT false,
        icon VARCHAR(50),
        slides_data JSONB NOT NULL,
        preview_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
      CREATE INDEX IF NOT EXISTS idx_templates_is_premium ON templates(is_premium);
      CREATE INDEX IF NOT EXISTS idx_templates_is_popular ON templates(is_popular);

      -- ============================================
      -- КОМАНДНАЯ РАБОТА (НОВЫЕ ТАБЛИЦЫ)
      -- ============================================
      
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
        plan_type VARCHAR(50) DEFAULT 'team',
        max_members INTEGER DEFAULT 5,
        storage_used BIGINT DEFAULT 0,
        storage_limit BIGINT DEFAULT 10737418240,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS team_members (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'viewer',
        invited_by UUID REFERENCES users(id),
        invited_at TIMESTAMPTZ DEFAULT NOW(),
        joined_at TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'pending',
        UNIQUE(workspace_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS team_templates (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        slides_data JSONB NOT NULL,
        created_by UUID REFERENCES users(id),
        is_favorite BOOLEAN DEFAULT FALSE,
        used_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS comments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        presentation_id UUID REFERENCES presentations(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        slide_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS presentation_versions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        presentation_id UUID REFERENCES presentations(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        slides_data JSONB NOT NULL,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_team_members_workspace ON team_members(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_comments_presentation ON comments(presentation_id);
      CREATE INDEX IF NOT EXISTS idx_presentation_versions_presentation ON presentation_versions(presentation_id);

      -- ВСТАВКА ШАБЛОНОВ
      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Пустой', 'Начните с чистого листа', 'Все', '#1A1A1A', '#2A2A2A', 1, false, false, 'crop_original_rounded', '[{"title":"Новая презентация","content":["Начните добавлять контент"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Влияние соседей на продуктивность', 'Анализ влияния окружения на эффективность работы', 'Бизнес', '#667eea', '#764ba2', 8, false, true, 'people_rounded', '[{"title":"Влияние соседей на продуктивность","content":["Анализ влияния окружения","Ключевые факторы"]},{"title":"Статистика","content":["Данные исследования","Графики зависимости"]},{"title":"Выводы","content":["Рекомендации по улучшению","Практические советы"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Видео-репортаж про продукт', 'Презентация продукта в формате видео-отчета', 'Маркетинг', '#f093fb', '#f5576c', 6, false, true, 'videocam_rounded', '[{"title":"Видео-репортаж","content":["О продукте","Ключевые особенности"]},{"title":"Демонстрация","content":["Скриншоты","Видео материалы"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Бордер-колли: ваш активный друг', 'Происхождение, характер, дрессировка и уход', 'Личные', '#4facfe', '#00f2fe', 10, false, true, 'pets_rounded', '[{"title":"Бордер-колли","content":["Происхождение породы","Характер"]},{"title":"Дрессировка","content":["Основные команды","Советы по обучению"]},{"title":"Уход","content":["Питание","Здоровье","Физические нагрузки"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Александр Волков', 'Архитектор цифровых стратегий и лидер продуктовых команд', 'Личные', '#434343', '#000000', 5, false, false, 'person_rounded', '[{"title":"Александр Волков","content":["Архитектор цифровых стратегий","Лидер продуктовых команд"]},{"title":"Опыт работы","content":["Проекты","Достижения"]},{"title":"Контакты","content":["Email","Telegram","LinkedIn"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Бизнес-план', 'Структура и финансовые показатели', 'Бизнес', '#1DB954', '#1ED760', 8, false, false, 'business_center_rounded', '[{"title":"Бизнес-план","content":["Краткое описание проекта","Цели и задачи"]},{"title":"Анализ рынка","content":["Конкуренты","Целевая аудитория","Тренды"]},{"title":"Финансовый план","content":["Прогноз доходов","Инвестиции","Окупаемость"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Маркетинговая стратегия', 'План продвижения на 2024 год', 'Маркетинг', '#fa709a', '#fee140', 12, false, false, 'trending_up_rounded', '[{"title":"Маркетинговая стратегия","content":["Цели","KPI","Бюджет"]},{"title":"Каналы продвижения","content":["SEO","Контекстная реклама","Соцсети"]},{"title":"Календарный план","content":["Мероприятия","Дедлайны"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('План урока', 'Готовая структура занятия', 'Образование', '#8E2DE2', '#4A00E0', 8, false, true, 'school_rounded', '[{"title":"План урока","content":["Тема урока","Цели и задачи"]},{"title":"Ход урока","content":["Организационный момент","Объяснение","Закрепление","Рефлексия"]},{"title":"Домашнее задание","content":["Задание","Сроки"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Годовой аналитический отчет', 'supr.ru — полный анализ деятельности за год', 'Отчёты', '#11998e', '#38ef7d', 15, false, true, 'analytics_rounded', '[{"title":"Годовой аналитический отчет","content":["Ключевые показатели","Динамика роста","Достижения"]},{"title":"Ключевые метрики","content":["Выручка","Прибыль","Клиенты","ROI"]},{"title":"Планы на следующий год","content":["Цели","Задачи","Бюджет"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Статус проекта', 'Отчёт о ходе выполнения', 'Отчёты', '#FF416C', '#FF4B2B', 6, false, false, 'task_alt_rounded', '[{"title":"Статус проекта","content":["Общая информация","Даты"]},{"title":"Выполненные задачи","content":["Список завершённых задач"]},{"title":"Риски и проблемы","content":["Текущие риски","План решения"]}]')
      ON CONFLICT DO NOTHING;

      -- ПРЕМИУМ ШАБЛОНЫ
      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Четыре колонки', 'Сравнение 4-х показателей', 'Бизнес', '#1DB954', '#1ED760', 3, true, true, 'view_quilt_rounded', '[{"title":"Сравнительный анализ","content":["Показатель 1","Показатель 2","Показатель 3","Показатель 4"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('SWOT-анализ', 'Сильные и слабые стороны', 'Бизнес', '#667eea', '#764ba2', 4, true, true, 'analytics_rounded', '[{"title":"SWOT-анализ","content":["Сильные стороны","Слабые стороны","Возможности","Угрозы"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Таймлайн', 'Визуализация событий во времени', 'Бизнес', '#f093fb', '#f5576c', 5, true, false, 'timeline_rounded', '[{"title":"История проекта","content":["Этап 1: 2020","Этап 2: 2021","Этап 3: 2022","Этап 4: 2023"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Команда', 'Представление сотрудников', 'Бизнес', '#4facfe', '#00f2fe', 6, true, true, 'group_rounded', '[{"title":"Наша команда","content":["Имя: Должность","Имя: Должность","Имя: Должность"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Портфолио', 'Ваши лучшие работы', 'Личные', '#00b4db', '#0083B0', 10, true, false, 'photo_library_rounded', '[{"title":"Проект 1","content":["Описание проекта","Результаты"]},{"title":"Проект 2","content":["Описание проекта","Результаты"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Питч стартапа', 'Презентация для инвесторов', 'Бизнес', '#FFE000', '#799F0C', 8, true, true, 'rocket_launch_rounded', '[{"title":"Наш стартап","content":["Проблема","Решение","Рынок"]},{"title":"Финансы","content":["Прогноз доходов","Инвестиции"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('KPI Dashboard', 'Отчёт с метриками', 'Отчёты', '#FF416C', '#FF4B2B', 7, true, true, 'dashboard_rounded', '[{"title":"Ключевые показатели","content":["Выручка: 1.2M","Прибыль: 300K","Клиенты: 5000"]},{"title":"Динамика","content":["График роста","Сезонность"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Дорожная карта', 'План развития продукта', 'Бизнес', '#11998e', '#38ef7d', 6, true, false, 'map_rounded', '[{"title":"Дорожная карта","content":["Q1 2024","Q2 2024","Q3 2024","Q4 2024"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Контакты', 'Карта и контактная информация', 'Бизнес', '#8E2DE2', '#4A00E0', 4, true, false, 'contact_phone_rounded', '[{"title":"Свяжитесь с нами","content":["Телефон","Email","Адрес"]}]')
      ON CONFLICT DO NOTHING;

      INSERT INTO templates (title, description, category, color1, color2, slide_count, is_premium, is_popular, icon, slides_data) VALUES
      ('Сравнение продуктов', 'Сравнение характеристик', 'Маркетинг', '#434343', '#000000', 5, true, false, 'compare_arrows_rounded', '[{"title":"Сравнение","content":["Функция 1","Продукт А","Продукт Б","Продукт В"]}]')
      ON CONFLICT DO NOTHING;
    `);
    
    console.log('✅ Таблицы созданы/проверены');
    console.log('✅ 20 шаблонов добавлено');
    console.log('✅ Командные таблицы созданы');
  } catch (e) {
    console.error('❌ Ошибка создания таблиц:', e.message);
  }
}

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
    req.user = { id: 'guest', email: 'guest@demo.com', name: 'Гость', is_premium: false, free_generations_left: 5 };
    return next();
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.is_premium, u.premium_expiry, u.free_generations_left
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length > 0) {
      req.user = result.rows[0];
    } else {
      req.user = { id: 'guest', email: 'guest@demo.com', name: 'Гость', is_premium: false, free_generations_left: 5 };
    }
    next();
  } catch (e) {
    req.user = { id: 'guest', email: 'guest@demo.com', name: 'Гость', is_premium: false, free_generations_left: 5 };
    next();
  }
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
// СОЦИАЛЬНАЯ АВТОРИЗАЦИЯ
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/social', async (req, res) => {
  if (!pool) {
    return res.json({ 
      token: 'demo-token', 
      user: { 
        id: 'demo', 
        email: req.body.email || `${req.body.id}@social.com`,
        name: req.body.name || 'Пользователь',
        isPremium: false,
        freeGenerationsLeft: 10 
      } 
    });
  }

  try {
    const { id, email, name, avatarUrl, provider } = req.body;
    
    if (!id || !provider) {
      return res.status(400).json({ error: 'Недостаточно данных для авторизации' });
    }

    const socialId = `${provider}_${id}`;
    const userEmail = email || `${id}@${provider}.social.com`;
    
    let result = await pool.query(
      'SELECT * FROM users WHERE social_id = $1 OR email = $2',
      [socialId, userEmail.toLowerCase()]
    );

    let user;

    if (result.rows.length === 0) {
      const insertResult = await pool.query(
        `INSERT INTO users (email, name, social_id, social_provider, avatar_url, free_generations_left)
         VALUES ($1, $2, $3, $4, $5, 10)
         RETURNING id, email, name, is_premium, free_generations_left, avatar_url`,
        [userEmail.toLowerCase(), name || 'Пользователь', socialId, provider, avatarUrl || null]
      );
      user = insertResult.rows[0];
      console.log(`✅ Новый пользователь через ${provider}: ${user.name}`);
    } else {
      user = result.rows[0];
      if (!user.avatar_url && avatarUrl) {
        await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, user.id]);
        user.avatar_url = avatarUrl;
      }
      console.log(`✅ Вход через ${provider}: ${user.name}`);
    }

    const sessionToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) 
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    res.json({
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: user.is_premium || false,
        freeGenerationsLeft: user.free_generations_left || 10,
        avatarUrl: user.avatar_url,
        socialProvider: provider,
      }
    });
    
  } catch (error) {
    console.error('❌ Social auth error:', error);
    res.status(500).json({ error: 'Ошибка социальной авторизации' });
  }
});

// ═══════════════════════════════════════════════════════════════
// TEMPLATES API
// ═══════════════════════════════════════════════════════════════

app.get('/api/templates', optionalAuth, async (req, res) => {
  if (!pool) {
    return res.json({ success: true, templates: [] });
  }

  try {
    const { include_premium } = req.query;
    const user = req.user;
    
    let query = 'SELECT * FROM templates WHERE 1=1';
    const showPremium = include_premium === 'true' && user && user.is_premium;
    if (!showPremium) {
      query += ' AND is_premium = false';
    }
    query += ' ORDER BY is_popular DESC, created_at DESC';
    
    const result = await pool.query(query);
    res.json({ success: true, templates: result.rows });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/templates/free', async (req, res) => {
  if (!pool) return res.json({ success: true, templates: [] });
  try {
    const result = await pool.query('SELECT * FROM templates WHERE is_premium = false ORDER BY is_popular DESC, created_at DESC');
    res.json({ success: true, templates: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/templates/premium', optionalAuth, async (req, res) => {
  if (!pool) return res.json({ success: true, templates: [] });
  try {
    const user = req.user;
    if (!user || (user.id !== 'guest' && !user.is_premium)) {
      return res.status(403).json({ error: 'Premium доступ только для подписчиков' });
    }
    const result = await pool.query('SELECT * FROM templates WHERE is_premium = true ORDER BY is_popular DESC, created_at DESC');
    res.json({ success: true, templates: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// WORKSPACES API (КОМАНДНАЯ РАБОТА)
// ═══════════════════════════════════════════════════════════════

// GET /api/workspaces - получить все рабочие пространства пользователя
app.get('/api/workspaces', optionalAuth, async (req, res) => {
  if (!pool) return res.json({ workspaces: [] });
  try {
    const user = req.user;
    if (user.id === 'guest') return res.json({ workspaces: [] });
    
    const result = await pool.query(`
      SELECT w.*, 
        (SELECT COUNT(*) FROM team_members WHERE workspace_id = w.id AND status = 'active') as member_count
      FROM workspaces w
      JOIN team_members tm ON w.id = tm.workspace_id
      WHERE tm.user_id = $1 AND tm.status = 'active'
    `, [user.id]);
    
    res.json({ workspaces: result.rows });
  } catch (error) {
    console.error('Error fetching workspaces:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workspaces - создать новое рабочее пространство
app.post('/api/workspaces', optionalAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const user = req.user;
    if (user.id === 'guest') return res.status(401).json({ error: 'Требуется авторизация' });
    
    const { name, planType = 'team' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });
    
    const result = await pool.query(`
      INSERT INTO workspaces (name, owner_id, plan_type, max_members)
      VALUES ($1, $2, $3, CASE WHEN $3 = 'team' THEN 5 WHEN $3 = 'business' THEN 20 ELSE 100 END)
      RETURNING *
    `, [name, user.id, planType]);
    
    const workspace = result.rows[0];
    
    await pool.query(`
      INSERT INTO team_members (workspace_id, user_id, role, status, joined_at)
      VALUES ($1, $2, 'admin', 'active', NOW())
    `, [workspace.id, user.id]);
    
    res.json({ workspace });
  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workspaces/:id/members - получить участников команды
app.get('/api/workspaces/:id/members', optionalAuth, async (req, res) => {
  if (!pool) return res.json({ members: [] });
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT tm.*, u.name, u.email, u.avatar_url
      FROM team_members tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.workspace_id = $1
    `, [id]);
    
    res.json({ members: result.rows });
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workspaces/:id/invite - пригласить участника
app.post('/api/workspaces/:id/invite', optionalAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const user = req.user;
    const { id } = req.params;
    const { email, role = 'viewer' } = req.body;
    
    if (user.id === 'guest') return res.status(401).json({ error: 'Требуется авторизация' });
    
    // Проверяем права
    const memberCheck = await pool.query(
      'SELECT role FROM team_members WHERE workspace_id = $1 AND user_id = $2 AND status = $3',
      [id, user.id, 'active']
    );
    
    if (memberCheck.rows.length === 0 || !['admin', 'editor'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    
    // Находим пользователя по email
    const userResult = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email.toLowerCase()]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const invitedUser = userResult.rows[0];
    
    // Проверяем, не в команде ли уже
    const existing = await pool.query(
      'SELECT id FROM team_members WHERE workspace_id = $1 AND user_id = $2',
      [id, invitedUser.id]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь уже в команде' });
    }
    
    await pool.query(`
      INSERT INTO team_members (workspace_id, user_id, role, invited_by, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `, [id, invitedUser.id, role, user.id]);
    
    res.json({ success: true, message: `Приглашение отправлено ${invitedUser.email}` });
  } catch (error) {
    console.error('Error inviting member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/workspaces/:id/members/:memberId/role - изменить роль участника
app.put('/api/workspaces/:id/members/:memberId/role', optionalAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const user = req.user;
    const { id, memberId } = req.params;
    const { role } = req.body;
    
    if (user.id === 'guest') return res.status(401).json({ error: 'Требуется авторизация' });
    
    const memberCheck = await pool.query(
      'SELECT role FROM team_members WHERE workspace_id = $1 AND user_id = $2 AND status = $3',
      [id, user.id, 'active']
    );
    
    if (memberCheck.rows.length === 0 || memberCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Только администратор может менять роли' });
    }
    
    await pool.query(
      'UPDATE team_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3',
      [role, id, memberId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/workspaces/:id/members/:memberId - удалить участника
app.delete('/api/workspaces/:id/members/:memberId', optionalAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const user = req.user;
    const { id, memberId } = req.params;
    
    if (user.id === 'guest') return res.status(401).json({ error: 'Требуется авторизация' });
    
    const memberCheck = await pool.query(
      'SELECT role FROM team_members WHERE workspace_id = $1 AND user_id = $2 AND status = $3',
      [id, user.id, 'active']
    );
    
    if (memberCheck.rows.length === 0 || memberCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Только администратор может удалять участников' });
    }
    
    await pool.query(
      'DELETE FROM team_members WHERE workspace_id = $1 AND user_id = $2',
      [id, memberId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workspaces/:id/templates - получить общие шаблоны команды
app.get('/api/workspaces/:id/templates', optionalAuth, async (req, res) => {
  if (!pool) return res.json({ templates: [] });
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT tt.*, u.name as created_by_name
      FROM team_templates tt
      LEFT JOIN users u ON tt.created_by = u.id
      WHERE tt.workspace_id = $1
      ORDER BY tt.is_favorite DESC, tt.used_count DESC
    `, [id]);
    
    res.json({ templates: result.rows });
  } catch (error) {
    console.error('Error fetching team templates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workspaces/:id/templates - добавить общий шаблон
app.post('/api/workspaces/:id/templates', optionalAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const user = req.user;
    const { id } = req.params;
    const { name, slides_data } = req.body;
    
    if (user.id === 'guest') return res.status(401).json({ error: 'Требуется авторизация' });
    
    const result = await pool.query(`
      INSERT INTO team_templates (workspace_id, name, slides_data, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, name, slides_data, user.id]);
    
    res.json({ template: result.rows[0] });
  } catch (error) {
    console.error('Error creating team template:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// COMMENTS API
// ═══════════════════════════════════════════════════════════════

// GET /api/presentations/:id/comments - получить комментарии к презентации
app.get('/api/presentations/:id/comments', optionalAuth, async (req, res) => {
  if (!pool) return res.json({ comments: [] });
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT c.*, u.name, u.avatar_url
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.presentation_id = $1
      ORDER BY c.created_at ASC
    `, [id]);
    
    res.json({ comments: result.rows });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/presentations/:id/comments - добавить комментарий
app.post('/api/presentations/:id/comments', optionalAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const user = req.user;
    const { id } = req.params;
    const { slide_index, content, parent_id } = req.body;
    
    if (user.id === 'guest') return res.status(401).json({ error: 'Требуется авторизация' });
    
    const result = await pool.query(`
      INSERT INTO comments (presentation_id, user_id, slide_index, content, parent_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [id, user.id, slide_index, content, parent_id || null]);
    
    res.json({ comment: result.rows[0] });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/comments/:id/resolve - отметить комментарий как решённый
app.put('/api/comments/:id/resolve', optionalAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const { id } = req.params;
    await pool.query('UPDATE comments SET resolved = NOT resolved WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error resolving comment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  if (!pool) {
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: req.body.name || 'Demo' } });
  }

  try {
    const { email, password, name } = req.body;
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
    return res.json({ token: 'demo-token', user: { id: 'demo', email: req.body.email, name: 'Demo', isPremium: true, freeGenerationsLeft: 999 } });
  }

  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const result = await pool.query(
      'SELECT id, email, name, password_hash, is_premium, premium_expiry, free_generations_left, failed_login_attempts, locked_until FROM users WHERE email = $1',
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
      user: { id: user.id, email: user.email, name: user.name, isPremium: user.is_premium, premiumExpiry: user.premium_expiry, freeGenerationsLeft: user.free_generations_left }
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
    const { topic, maxSlides = 5 } = req.body;
    if (!topic) return res.status(400).json({ error: 'Тема не указана' });

    const user = req.user;
    console.log(`🎯 Генерация: "${topic}" (${user.email})`);

    if (pool && user.id !== 'guest' && !user.is_premium && user.free_generations_left <= 0) {
      return res.status(402).json({ error: 'Бесплатные генерации закончились' });
    }

    const prompt = `Ты — эксперт. Создай структуру презентации: "${topic}". Слайдов: ${maxSlides}.

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

    if (pool && user.id !== 'guest') {
      await pool.query(
        'UPDATE users SET free_generations_left = GREATEST(0, free_generations_left - 1), total_generations = total_generations + 1 WHERE id = $1',
        [user.id]
      );
    }
    
    console.log(`✅ ${presentation.slides?.length || 0} слайдов`);
    res.json(presentation);
  } catch (e) {
    console.error('❌ Generation error:', e.message);
    
    const slides = [];
    for (let i = 0; i < (maxSlides || 5); i++) {
      slides.push({
        title: i === 0 ? `Введение: ${req.body.topic}` : i === (maxSlides || 5) - 1 ? 'Заключение' : `${req.body.topic} — часть ${i + 1}`,
        content: [`Ключевой тезис ${i * 3 + 1}`, `Ключевой тезис ${i * 3 + 2}`, `Ключевой тезис ${i * 3 + 3}`]
      });
    }
    res.json({ title: req.body.topic, slides });
  }
});

// Improve
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
    console.log(`📋 Шаблоны: 20 шаблонов`);
    console.log(`👥 Командная работа: включена`);
    console.log(`🔐 Социальная авторизация: Google, Apple, VK`);
    console.log(`🔓 Генерация работает без авторизации`);
  });
});