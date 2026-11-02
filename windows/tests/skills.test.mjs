// Tests for Universal Skills Engine (Karpathy Guidelines, Metaskill, Composio & Awesome Skills)

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  KarpathySkills,
  MetaskillEngine,
  ComposioAwesomeSkills,
  executeSkillFromQuery,
  extractSkillPayload,
  formatSkillResultMarkdown,
  AutoclickerSkill,
  DirectMessageSkill,
} = await import("../src/core/skills.ts");
test("Karpathy guidelines provides 4 core principles and checks code", async () => {
  assert.equal(KarpathySkills.principles.length, 4);
  assert.ok(KarpathySkills.principles.some((p) => p.id === "think-before-coding"));
  assert.ok(KarpathySkills.principles.some((p) => p.id === "simplicity-first"));
  assert.ok(KarpathySkills.principles.some((p) => p.id === "surgical-changes"));
  assert.ok(KarpathySkills.principles.some((p) => p.id === "goal-driven"));

  const cleanRes = KarpathySkills.check("const x = 5;\nconsole.log(x);");
  assert.equal(cleanRes.compliant, true);

  const dirtyRes = KarpathySkills.check("function doWork() { // TODO: implement later\n return null; }");
  assert.equal(dirtyRes.compliant, false);
  assert.ok(dirtyRes.warnings.length > 0);
});

test("Metaskill engine creates agent teams, specialist agents, and custom skills", async () => {
  const team = MetaskillEngine.createTeam("ios app with SwiftUI");
  assert.ok(team.agents.length >= 3);
  assert.ok(team.agents.some((a) => a.role.includes("Lead")));
  assert.ok(team.agents.some((a) => a.role.includes("Engineer")));

  const agent = MetaskillEngine.createAgent("Security Reviewer");
  assert.equal(agent.role, "Security Reviewer");
  assert.ok(agent.systemPrompt.includes("Security Reviewer"));

  const skill = MetaskillEngine.createSkill("deploy-prod");
  assert.equal(skill.skillName, "deploy-prod");
  assert.ok(skill.declaration.includes("SKILL.md"));
});

test("Composio & Awesome Skills catalogs 30+ production skills", async () => {
  assert.ok(ComposioAwesomeSkills.skillsList.length >= 25);
  const mcp = ComposioAwesomeSkills.getSkill("mcp-builder");
  assert.ok(mcp);
  assert.equal(mcp.id, "mcp-builder");

  const artifact = ComposioAwesomeSkills.getSkill("artifacts-builder");
  assert.ok(artifact);

  const doc = ComposioAwesomeSkills.getSkill("document-pdf");
  assert.ok(doc);
});

test("Slash commands route to corresponding universal skills", async () => {
  const skillsRes = await executeSkillFromQuery("/skills");
  assert.ok(skillsRes);
  assert.equal(skillsRes.action, "all_skills_overview");
  assert.ok(skillsRes.output.karpathy);
  assert.ok(skillsRes.output.metaskill);
  assert.ok(skillsRes.output.awesome);

  const karpathyRes = await executeSkillFromQuery("/karpathy");
  assert.ok(karpathyRes);
  assert.equal(karpathyRes.skill, "karpathy_guidelines");

  const metaRes = await executeSkillFromQuery("/metaskill web app with React");
  assert.ok(metaRes);
  assert.equal(metaRes.skill, "metaskill");
  assert.equal(metaRes.action, "team");

  const mcpRes = await executeSkillFromQuery("/mcp");
  assert.ok(mcpRes);
  assert.equal(mcpRes.action, "mcp-builder");

  const artifactRes = await executeSkillFromQuery("/artifact");
  assert.ok(artifactRes);
  assert.equal(artifactRes.action, "artifacts-builder");

  const clickerRes = await executeSkillFromQuery("/autoclicker stop");
  assert.ok(clickerRes);
  assert.equal(clickerRes.skill, "autoclicker");
  assert.equal(clickerRes.action, "stop");
});

test("AutoclickerSkill handles status and stop actions cleanly", async () => {
  const stopRes = await AutoclickerSkill.execute({ action: "stop" });
  assert.equal(stopRes.skill, "autoclicker");
  assert.equal(stopRes.action, "stop");
  assert.equal(stopRes.success, true);

  const statusRes = await AutoclickerSkill.execute({ action: "status" });
  assert.equal(statusRes.skill, "autoclicker");
  assert.equal(statusRes.action, "status");
  assert.equal(statusRes.success, true);
});

test("DirectMessageSkill validates empty input and formats message", async () => {
  const emptyRes = await DirectMessageSkill.execute({ text: "" });
  assert.equal(emptyRes.skill, "direct-message");
  assert.equal(emptyRes.success, false);
  assert.ok(emptyRes.message.includes("boş olamaz"));
});
test("extractSkillPayload parses karpathy, metaskill, and awesome skill blocks", () => {
  const text1 = '```skill:karpathy\n{"action":"check","text":"test"}\n```';
  const p1 = extractSkillPayload(text1);
  assert.ok(p1);
  assert.equal(p1.skillName, "karpathy");

  const text2 = '```skill:metaskill\n{"intent":"ios app"}\n```';
  const p2 = extractSkillPayload(text2);
  assert.ok(p2);
  assert.equal(p2.skillName, "metaskill");

  const text3 = '```skill:awesome\n{"name":"mcp-builder"}\n```';
  const p3 = extractSkillPayload(text3);
  assert.ok(p3);
  assert.equal(p3.skillName, "awesome");
});

test("formatSkillResultMarkdown renders rich markdown for universal skills", () => {
  const r1 = {
    skill: "karpathy_guidelines",
    action: "principles",
    success: true,
    message: "İlkeler aktif",
  };
  const md1 = formatSkillResultMarkdown(r1);
  assert.ok(md1.includes("Andrej Karpathy"));
  assert.ok(md1.includes("Think Before Coding"));

  const r2 = {
    skill: "metaskill",
    action: "team",
    success: true,
    message: "Takım kuruldu",
    output: {
      generatedConfig: "config.json",
      agents: [{ role: "Lead", responsibility: "Orchestrate" }],
    },
  };
  const md2 = formatSkillResultMarkdown(r2);
  assert.ok(md2.includes("Metaskill"));
  assert.ok(md2.includes("Lead"));

  const r3 = {
    skill: "awesome_skills",
    action: "all_skills_overview",
    success: true,
    message: "Beceriler",
  };
  const md3 = formatSkillResultMarkdown(r3);
  assert.ok(md3.includes("Evrensel Beceriler"));
  assert.ok(md3.includes("Composio"));
});
