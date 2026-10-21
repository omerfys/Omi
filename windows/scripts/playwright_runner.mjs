#!/usr/bin/env node
// Omi Playwright Skill Runner
// Advanced browser automation, web testing, and content extraction engine.
// Executes actions: navigate, click, fill, press, screenshot, scrape, get_text, evaluate, wait.

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

async function main() {
  let inputRaw = process.argv[2];
  if (!inputRaw || inputRaw === "-") {
    inputRaw = readFileSync(0, "utf-8");
  }

  let params;
  try {
    params = JSON.parse(inputRaw);
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: `Invalid JSON parameters: ${err.message}`,
    }));
    process.exit(1);
  }

  const action = (params.action || "navigate").toLowerCase();
  const headless = params.headless !== false;
  const timeout = params.timeout || 30000;

  let browser;
  try {
    // Auto-detect browser channel: try system msedge, chrome, or default chromium
    const launchOptions = {
      headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
      ],
    };

    try {
      browser = await chromium.launch({ ...launchOptions, channel: "msedge" });
    } catch {
      try {
        browser = await chromium.launch({ ...launchOptions, channel: "chrome" });
      } catch {
        browser = await chromium.launch(launchOptions);
      }
    }

    const context = await browser.newContext({
      userAgent: params.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      viewport: { width: params.width || 1280, height: params.height || 800 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // Initial navigation if url provided
    if (params.url) {
      await page.goto(params.url, { waitUntil: params.waitUntil || "domcontentloaded" });
    }

    let result = {
      success: true,
      action,
      url: page.url(),
      title: await page.title().catch(() => ""),
    };

    switch (action) {
      case "navigate":
      case "goto":
      case "open": {
        if (!params.url) throw new Error("URL is required for navigate action");
        if (params.screenshot) {
          const buffer = await page.screenshot({ fullPage: params.fullPage === true });
          result.screenshot = buffer.toString("base64");
        }
        result.message = `Successfully navigated to ${page.url()} ("${result.title}")`;
        break;
      }

      case "click": {
        if (!params.selector) throw new Error("Selector is required for click action");
        await page.waitForSelector(params.selector, { state: "visible", timeout });
        await page.click(params.selector);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        result.message = `Clicked selector '${params.selector}'`;
        if (params.screenshot) {
          const buffer = await page.screenshot({ fullPage: params.fullPage === true });
          result.screenshot = buffer.toString("base64");
        }
        break;
      }

      case "fill":
      case "type": {
        if (!params.selector) throw new Error("Selector is required for fill action");
        await page.waitForSelector(params.selector, { state: "visible", timeout });
        await page.fill(params.selector, params.text ?? "");
        result.message = `Filled '${params.selector}' with text`;
        break;
      }

      case "press": {
        const key = params.key || "Enter";
        if (params.selector) {
          await page.press(params.selector, key);
        } else {
          await page.keyboard.press(key);
        }
        result.message = `Pressed key '${key}'`;
        break;
      }

      case "screenshot": {
        const buffer = await page.screenshot({ fullPage: params.fullPage === true });
        result.screenshot = buffer.toString("base64");
        if (params.outputPath) {
          writeFileSync(params.outputPath, buffer);
          result.savedPath = params.outputPath;
        }
        result.message = `Captured screenshot (${buffer.length} bytes)`;
        break;
      }

      case "scrape":
      case "get_text":
      case "read": {
        let textContent = "";
        if (params.selector) {
          textContent = await page.locator(params.selector).innerText().catch(() => "");
        } else {
          // Extract main body content cleanly, removing scripts and styles
          textContent = await page.evaluate(() => {
            const clone = document.body.cloneNode(true);
            const removeSelectors = ["script", "style", "noscript", "iframe", "svg", "header", "footer", "nav"];
            for (const s of removeSelectors) {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            }
            return clone.innerText || "";
          });
        }
        // Normalize whitespace and limit length if requested
        const cleanText = textContent.replace(/\n{3,}/g, "\n\n").trim();
        const maxLen = params.maxLength || 4000;
        result.text = cleanText.length > maxLen ? `${cleanText.slice(0, maxLen)}\n... [truncated]` : cleanText;
        result.message = `Scraped content from ${page.url()} (${result.text.length} chars)`;
        break;
      }

      case "evaluate":
      case "eval": {
        if (!params.expression) throw new Error("Expression is required for evaluate action");
        const evalResult = await page.evaluate(params.expression);
        result.evalResult = evalResult;
        result.message = `Evaluated expression successfully`;
        break;
      }

      case "wait": {
        if (params.selector) {
          await page.waitForSelector(params.selector, { timeout });
          result.message = `Waited for selector '${params.selector}'`;
        } else if (params.delay) {
          await page.waitForTimeout(params.delay);
          result.message = `Waited for ${params.delay}ms`;
        }
        break;
      }

      default:
        throw new Error(`Unknown Playwright action: '${action}'`);
    }

    console.log(JSON.stringify(result));
    await browser.close();
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.log(JSON.stringify({
      success: false,
      error: err.message,
      action,
    }));
    process.exit(1);
  }
}

main();
