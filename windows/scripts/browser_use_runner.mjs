#!/usr/bin/env node
// Omi Browser-Use Skill Runner
// Inspired by browser-use: interactive element indexing, Set-of-Mark visual tagging,
// natural web browsing, multi-tab management, and intelligent content extraction.

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

  const action = (params.action || "open_url").toLowerCase();
  const headless = params.headless !== false;
  const timeout = params.timeout || 30000;

  const launchOptions = {
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
  };

  let browser;
  try {
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
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // Initial URL or Google search
    if (params.url) {
      const targetUrl = params.url.startsWith("http") ? params.url : `https://${params.url}`;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    } else if (params.search) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(params.search)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    }

    // Helper: Injects Browser-Use Interactive Element Indexer (Set-of-Mark)
    async function indexInteractiveElements() {
      return await page.evaluate(() => {
        const interactiveSelectors = [
          "a[href]", "button", "input", "textarea", "select",
          "[role='button']", "[role='link']", "[role='checkbox']",
          "[contenteditable='true']", "summary"
        ];
        const elements = Array.from(document.querySelectorAll(interactiveSelectors.join(",")));
        const visibleElements = [];

        let index = 1;
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 &&
            rect.top >= -50 && rect.top <= window.innerHeight + 50 &&
            window.getComputedStyle(el).visibility !== "hidden" &&
            window.getComputedStyle(el).display !== "none";

          if (isVisible) {
            el.setAttribute("data-browser-use-index", String(index));
            const text = (el.innerText || el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "").trim().slice(0, 80);
            visibleElements.push({
              index,
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute("type") || undefined,
              text,
              selector: `[data-browser-use-index="${index}"]`,
              rect: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }
            });
            index++;
            if (index > 60) break; // cap at 60 for clean AI tokens
          }
        }
        return visibleElements;
      });
    }

    let result = {
      success: true,
      action,
      url: page.url(),
      title: await page.title().catch(() => ""),
    };

    switch (action) {
      case "open_url":
      case "navigate": {
        const elements = await indexInteractiveElements();
        result.elements = elements;
        const shotBuffer = await page.screenshot();
        result.screenshot = shotBuffer.toString("base64");
        result.message = `Successfully opened ${page.url()} ("${result.title}"). Indexed ${elements.length} interactive elements.`;
        break;
      }

      case "search_google":
      case "search": {
        const query = params.query || params.search || "";
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
        const elements = await indexInteractiveElements();
        result.elements = elements;
        const shotBuffer = await page.screenshot();
        result.screenshot = shotBuffer.toString("base64");
        result.message = `Searched Google for "${query}". Found ${elements.length} interactive elements.`;
        break;
      }

      case "click":
      case "click_element": {
        let selector = params.selector;
        if (params.index != null) {
          selector = `[data-browser-use-index="${params.index}"]`;
        }
        if (!selector) throw new Error("Element index or selector is required for click action");

        await page.waitForSelector(selector, { state: "visible", timeout: 10000 });
        await page.click(selector);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        const elements = await indexInteractiveElements();
        result.elements = elements;
        const shotBuffer = await page.screenshot();
        result.screenshot = shotBuffer.toString("base64");
        result.message = `Clicked element '${selector}'`;
        break;
      }

      case "type":
      case "input_text":
      case "fill": {
        let selector = params.selector;
        if (params.index != null) {
          selector = `[data-browser-use-index="${params.index}"]`;
        }
        if (!selector) throw new Error("Element index or selector is required for input action");

        await page.waitForSelector(selector, { state: "visible", timeout: 10000 });
        await page.fill(selector, params.text ?? "");
        if (params.pressEnter) {
          await page.press(selector, "Enter");
          await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
        const elements = await indexInteractiveElements();
        result.elements = elements;
        result.message = `Entered text into '${selector}'`;
        break;
      }

      case "scroll":
      case "scroll_page": {
        const direction = (params.direction || "down").toLowerCase();
        const amount = params.amount || (direction === "down" ? 600 : -600);
        await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: "smooth" }), amount);
        await page.waitForTimeout(600);
        const elements = await indexInteractiveElements();
        result.elements = elements;
        const shotBuffer = await page.screenshot();
        result.screenshot = shotBuffer.toString("base64");
        result.message = `Scrolled ${direction} by ${Math.abs(amount)}px`;
        break;
      }

      case "extract":
      case "extract_content": {
        const extracted = await page.evaluate(() => {
          const clone = document.body.cloneNode(true);
          const remove = ["script", "style", "noscript", "svg", "header", "footer", "nav", "iframe"];
          for (const s of remove) {
            clone.querySelectorAll(s).forEach((el) => el.remove());
          }
          return clone.innerText || "";
        });
        const clean = extracted.replace(/\n{3,}/g, "\n\n").trim();
        result.content = clean.slice(0, 6000);
        result.message = `Extracted ${result.content.length} characters of page content`;
        break;
      }

      default:
        throw new Error(`Unknown Browser-Use action: '${action}'`);
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
