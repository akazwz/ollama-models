# Ollama Models API

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Update](https://img.shields.io/badge/update-daily-brightgreen.svg)

A Cloudflare Worker that provides a comprehensive JSON API of all available Ollama models with their tags. Updates automatically every 24 hours.

## 🚀 Live API

**Endpoint:** [https://ollama-models.zwz.workers.dev](https://ollama-models.zwz.workers.dev)

## ✨ Features

- Complete list of all Ollama models
- Includes model descriptions
- Provides all available tags for each model
- Updated automatically every 24 hours
- Cached responses for improved performance
- Lightweight JSON format

## 📋 Example Response

```json
[
  {
    "name": "llama3",
    "description": "Meta's Llama 3 language model",
    "tags": ["8b", "70b", "latest"]
  },
  {
    "name": "mistral",
    "description": "Mistral AI's language model",
    "tags": ["7b", "instruct", "latest"]
  }
]
```

## 🛠️ Technology

- Cloudflare Workers
- TypeScript
- Cheerio for HTML parsing
- KV for caching
- pnpm package manager

## 🧑‍💻 Development

```bash
# Install dependencies
pnpm install

# Configure
cp wrangler.example.jsonc wrangler.jsonc
# Edit wrangler.jsonc with your Cloudflare account details

# Run locally
pnpm run dev

# Deploy
pnpm run deploy
```

## 📝 License

MIT

## 🔗 Links

- [Ollama Official Website](https://ollama.com)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)

---

Created with ❤️ by [akazwz](https://github.com/akazwz)