# Browser Automation Agent

A Chrome extension that automates browser tasks using vision and reasoning models. It sees the screen through Isaac (vision model) and decides actions through GPT-5.2 (reasoning model).

## How it Works

1. **Screenshot** - Captures the visible tab
2. **Vision Analysis** - Isaac identifies interactive elements (buttons, links, inputs)
3. **Reasoning** - GPT-5.2 decides what action to take based on the goal and page state
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

## Models

- **Isaac** (`isaac-0.2-2b-preview`) - Vision model for element detection and pointing
- **GPT-5.2** - Reasoning model for action planning

## Development

```bash
npm run build   # Build to dist/
npm run watch   # Watch mode (if configured)
```

After changes, reload the extension in `chrome://extensions`.
