# Browser Automation Agent

A Chrome extension that automates browser tasks using vision and reasoning models.

Built by [Perceptron](https://perceptron.inc).

> **Note:** This extension is for internal/demo use only. API keys are embedded in the build and visible to anyone who inspects the extension code. Do not distribute to end users.

## How it Works

1. **Screenshot** - Captures the visible tab
2. **Vision Analysis** - Vision model identifies interactive elements (buttons, links, inputs)
3. **Reasoning** - Reasoning model decides what action to take based on the goal and page state
4. **Execution** - Performs the action via Chrome DevTools Protocol (clicks, typing, scrolling)
5. **Loop** - Repeats until the goal is achieved

## Setup

1. Clone the repo

2. Copy `.env.example` to `.env` and add your API keys:

```bash
cp .env.example .env
```

3. Install dependencies and build:

```bash
npm install
npm run build
```

4. Load in Chrome:
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

## Usage

1. Click the extension icon to open the side panel
2. Navigate to any webpage
3. Type what you want to automate (e.g., "Search for flights to Tokyo")
4. Watch it work

## Configuration

Configure via environment variables in `.env`:

**Vision Model** (uses [Perceptron API](https://perceptron.inc))
- `PERCEPTRON_API_KEY` - Get your key at [platform.perceptron.inc](https://platform.perceptron.inc)
- `VISION_MODEL` - See [available models](https://docs.perceptron.inc/index#models)

**Reasoning Model**
- `REASONING_API_URL`
- `REASONING_API_KEY`
- `REASONING_MODEL`

## Development

```bash
npm run build   # Build to dist/
npm run watch   # Watch mode (if configured)
```

After changes, reload the extension in `chrome://extensions`.
