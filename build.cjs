const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// Load environment variables from .env
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  const env = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach((line) => {
      const [key, ...valueParts] = line.split("=");
      if (key && valueParts.length) {
        env[key.trim()] = valueParts.join("=").trim();
      }
    });
  }
  return env;
}

const env = loadEnv();

const isWatch = process.argv.includes("--watch");

// Ensure dist directory exists
if (!fs.existsSync("dist")) {
  fs.mkdirSync("dist");
}

// Copy static files
const staticFiles = ["manifest.json", "sidepanel.html", "sidepanel.css"];
staticFiles.forEach((file) => {
  fs.copyFileSync(path.join("src", file), path.join("dist", file));
});

// Copy icons directory
const iconsDir = path.join("dist", "icons");
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}
if (fs.existsSync(path.join("src", "icons"))) {
  fs.readdirSync(path.join("src", "icons")).forEach((file) => {
    fs.copyFileSync(path.join("src", "icons", file), path.join(iconsDir, file));
  });
}

// Common build options
const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: ["chrome120"],
  minify: false,
  define: {
    "process.env.PERCEPTRON_API_KEY": JSON.stringify(env.PERCEPTRON_API_KEY),
    "process.env.OPENAI_API_KEY": JSON.stringify(env.OPENAI_API_KEY),
  },
  jsx: "automatic",
  jsxImportSource: "preact",
};

// Build background script
const backgroundBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ["src/background.ts"],
  outfile: "dist/background.js",
  format: "esm",
});

// Build content script (action executor)
const contentBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ["src/content.ts"],
  outfile: "dist/content.js",
  format: "iife",
});

// Build side panel script
const sidepanelBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ["src/sidepanel/index.tsx"],
  outfile: "dist/sidepanel.js",
  format: "iife",
});

Promise.all([backgroundBuild, contentBuild, sidepanelBuild])
  .then(() => {
    console.log("Build completed successfully!");
    if (isWatch) {
      console.log("Watching for changes...");
    }
  })
  .catch((error) => {
    console.error("Build failed:", error);
    process.exit(1);
  });
