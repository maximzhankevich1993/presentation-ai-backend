# Presentation AI Backend

API сервер для генерации презентаций с помощью Искусственного Интеллекта.

## Возможности

- Генерация структуры презентации через DeepSeek API
- Автоматический поиск картинок через Unsplash API
- Генерация презентации с картинками в одном запросе

## Быстрый старт

### 1. Установка зависимостей 
npm install 

### 2. Настройка окружения
cp .env 

Отредактируй файл `.env` и добавь свои API ключи:
- `DEEPSEEK_API_KEY` — ключ от DeepSeek
- `UNSPLASH_ACCESS_KEY` — ключ от Unsplash

### 3. Запуск сервера
npm run dev

Сервер запустится на `http://localhost:3000`

## API Эндпоинты

| Метод | Путь | Описание |
|:---|:---|:---|
| GET | `/api/health` | Проверка работоспособности |
| POST | `/api/generate` | Генерация структуры презентации |
| POST | `/api/images/search` | Поиск картинок по ключевым словам |
| POST | `/api/generate-with-images` | Генерация презентации с картинками |

## Пример запроса


POST /api/generate-with-images
Content-Type: application/json

{
"topic": "Искусственный интеллект",
"maxSlides": 10
}

## Технологии

- Node.js
- Express
- Axios
- DeepSeek AI
- Unsplash API

## Получение API ключей

- [DeepSeek API](https://platform.deepseek.com/)
- [Unsplash Developers](https://unsplash.com/developers)

