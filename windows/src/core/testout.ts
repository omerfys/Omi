// Smart Test Output Parser
// Extracts structured test facts (passed, failed, skipped) from test runner logs.
// Ported and adapted from dotpals (MIT).

export interface TestSummary {
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  failing: string[];
}

const ANSI_REGEX = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;

function cleanLines(text: string): string[] {
  return text.replace(ANSI_REGEX, "").split(/\r?\n/);
}

export function parseTestOutput(text: string): TestSummary | null {
  const lines = cleanLines(text);

  // 1. Jest / Vitest: "Tests: 1 failed, 5 passed, 6 total"
  for (const line of lines) {
    const match = /Tests:\s+(.+)$/i.exec(line);
    if (match) {
      const rest = match[1];
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      for (const m of rest.matchAll(/(\d+)\s+(failed|passed|skipped|todo)/gi)) {
        const count = Number(m[1]);
        const type = m[2].toLowerCase();
        if (type === "passed") passed += count;
        else if (type === "failed") failed += count;
        else skipped += count;
      }
      return { runner: "Jest/Vitest", passed, failed, skipped, failing: [] };
    }
  }

  // 2. Cargo test: "test result: ok. 12 passed; 0 failed; 0 ignored"
  for (const line of lines) {
    const match = /test result:\s+(\w+)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/i.exec(line);
    if (match) {
      return {
        runner: "Cargo test",
        passed: Number(match[2]),
        failed: Number(match[3]),
        skipped: Number(match[4]),
        failing: [],
      };
    }
  }

  // 3. Pytest: "5 passed, 1 failed in 0.42s"
  for (const line of lines) {
    const match = /(?:(\d+)\s+failed)?(?:.*?(\d+)\s+passed)?(?:.*?(\d+)\s+skipped)?.*in\s+[\d.]+s/i.exec(line);
    if (match && (match[1] || match[2])) {
      return {
        runner: "Pytest",
        passed: Number(match[2] ?? 0),
        failed: Number(match[1] ?? 0),
        skipped: Number(match[3] ?? 0),
        failing: [],
      };
    }
  }

  // 4. TAP / Node --test: "tests 14\npass 14\nfail 0"
  let nodePass = -1;
  let nodeFail = -1;
  for (const line of lines) {
    const mPass = /^#\s*pass\s+(\d+)/i.exec(line);
    if (mPass) nodePass = Number(mPass[1]);
    const mFail = /^#\s*fail\s+(\d+)/i.exec(line);
    if (mFail) nodeFail = Number(mFail[1]);
  }
  if (nodePass >= 0) {
    return {
      runner: "Node --test",
      passed: nodePass,
      failed: Math.max(0, nodeFail),
      skipped: 0,
      failing: [],
    };
  }

  return null;
}

export function formatTestBadge(summary: TestSummary): string {
  const isOk = summary.failed === 0;
  const statusIcon = isOk ? "✅" : "❌";
  let text = `${statusIcon} **[${summary.runner}]** ${summary.passed} geçti`;
  if (summary.failed > 0) {
    text += `, **${summary.failed} başarısız**`;
  }
  if (summary.skipped > 0) {
    text += `, ${summary.skipped} atlandı`;
  }
  return text;
}
