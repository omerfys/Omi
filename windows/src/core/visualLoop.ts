// Omi Autonomous Visual Verification Loop Engine
// Inspired by Microsoft UFO (UI-Focused Agent) and Anthropic Computer Use
// Executes a closed feedback loop: Observe (Screenshot) -> Evaluate -> Act -> Verify -> Repeat until Done!

import { Bridge, type ScreenshotResult } from "./bridge";
import { Sound } from "./sound";
import { State } from "./state";

export interface VisualLoopStepResult {
  step: number;
  maxSteps: number;
  status: "done" | "in_progress" | "max_reached" | "failed";
  observation: string;
  actionPlanned?: string;
  explanation: string;
  shot?: ScreenshotResult;
}

export interface VisualLoopCallbacks {
  onStepStart?: (step: number, maxSteps: number) => void;
  onStepUpdate?: (result: VisualLoopStepResult) => void;
  onFinished?: (result: VisualLoopStepResult) => void;
}

/**
 * Runs the autonomous visual loop for a user task.
 * Continues taking screenshots, evaluating visual state with AI vision,
 * executing steps, and verifying until the goal is achieved or max steps reached.
 */
export async function runAutonomousVisualLoop(
  taskGoal: string,
  callbacks: VisualLoopCallbacks = {},
): Promise<VisualLoopStepResult> {
  const maxSteps = Math.max(1, Math.min(10, State.settings.visualLoopMaxSteps ?? 4));
  const delaySec = Math.max(0.5, Math.min(5, State.settings.visualLoopDelay ?? 1.5));

  let lastObservation = "";
  let lastAction = "";
  let lastExplanation = "";
  let lastShot: ScreenshotResult | undefined;

  for (let step = 1; step <= maxSteps; step++) {
    callbacks.onStepStart?.(step, maxSteps);

    // 1. Observe: Capture desktop screen
    let shot: ScreenshotResult;
    try {
      shot = await Bridge.takeScreenshot("fullscreen");
      lastShot = shot;
    } catch (err) {
      console.error("Visual loop screenshot capture error:", err);
      const res: VisualLoopStepResult = {
        step,
        maxSteps,
        status: "failed",
        observation: "Ekran görüntüsü alınamadı",
        explanation: `Ekran görüntüsü yakalanırken hata oluştu: ${String(err)}`,
      };
      callbacks.onFinished?.(res);
      return res;
    }

    // 2. Evaluate with Vision: Ask the AI to inspect screen and verify task progress
    const visionPrompt = `[OTONOM GÖRSEL DOĞRULAMA VE TEST MODU (AUTONOMOUS VISUAL VERIFICATION LOOP)]
Kullanıcının Hedefi/Görevi: "${taskGoal}"
Mevcut Doğrulama Döngü Adımı: ${step} / ${maxSteps}

Lütfen ekteki masaüstü ekran görüntüsünü dikkatle incele.
Bu ekran görüntüsüne göre kullanıcının istediği işlem masaüstünde gerçekten yapılmış ve hedefe ulaşılmış mı?

Cevabını kesinlikle aşağıdaki net formatta ver:
DURUM: [TAMAMLANDI veya DEVAM_EDIYOR]
GÖZLEM: (Ekranda şu an ne açık, hangi pencereler/içerikler görünüyor?)
EYLEM: (Eğer DURUM: DEVAM_EDIYOR ise hedefe ulaşmak için yapılması gereken sıradaki somut adım veya açılması gereken URL/uygulama. TAMAMLANDI ise "YOK")
AÇIKLAMA: (Kullanıcı için 1-2 cümlelik net özet)`;

    let replyText = "";
    try {
      const reply = await Bridge.chatSend(visionPrompt, {
        kind: "file",
        name: shot.name,
        path: shot.path,
      });
      replyText = reply.text;
    } catch (err) {
      console.error("Visual loop AI verification query error:", err);
      const res: VisualLoopStepResult = {
        step,
        maxSteps,
        status: "failed",
        observation: "Yapay zeka görsel analiz yapamadı",
        explanation: `Görsel analiz sırasında model yanıt vermedi: ${String(err)}`,
        shot,
      };
      callbacks.onFinished?.(res);
      return res;
    }

    // 3. Parse evaluation results
    const isDone = /DURUM:\s*TAMAMLANDI/i.test(replyText) || /STATUS:\s*(DONE|COMPLETED|SUCCESS)/i.test(replyText);

    // Extract GÖZLEM / Gözlem
    const obsMatch = replyText.match(/GÖZLEM:\s*(.*?)(?=\n[A-ZÇĞİÖŞÜ_]+:|$)/is);
    const observation = obsMatch ? obsMatch[1].trim() : "Masaüstü durumu incelendi.";
    lastObservation = observation;

    // Extract EYLEM / Eylem
    const actMatch = replyText.match(/EYLEM:\s*(.*?)(?=\n[A-ZÇĞİÖŞÜ_]+:|$)/is);
    const action = actMatch ? actMatch[1].trim() : "";
    lastAction = action;

    // Extract AÇIKLAMA / Açıklama
    const expMatch = replyText.match(/AÇIKLAMA:\s*(.*?)(?=\n[A-ZÇĞİÖŞÜ_]+:|$)/is);
    const explanation = expMatch ? expMatch[1].trim() : replyText;
    lastExplanation = explanation;

    // Check for actionable URL in proposed action
    const urlMatch = action.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      void Bridge.openUrl(urlMatch[0]);
    }

    if (isDone) {
      // Goal verified achieved with visual proof!
      void Sound.play("finish");
      const res: VisualLoopStepResult = {
        step,
        maxSteps,
        status: "done",
        observation,
        actionPlanned: action,
        explanation,
        shot,
      };
      callbacks.onStepUpdate?.(res);
      callbacks.onFinished?.(res);
      return res;
    }

    // Step complete but goal not reached yet:
    const stepRes: VisualLoopStepResult = {
      step,
      maxSteps,
      status: "in_progress",
      observation,
      actionPlanned: action,
      explanation,
      shot,
    };
    callbacks.onStepUpdate?.(stepRes);

    // Wait before next observation to allow desktop state/UI to settle
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, delaySec * 1000);
    await promise;
  }

  // Max steps reached
  void Sound.play("blip");
  const finalRes: VisualLoopStepResult = {
    step: maxSteps,
    maxSteps,
    status: "max_reached",
    observation: lastObservation,
    actionPlanned: lastAction,
    explanation: lastExplanation || "Belirlenen maksimum doğrulama adımına ulaşıldı. Lütfen masaüstü durumunu kontrol ediniz.",
    shot: lastShot,
  };
  callbacks.onFinished?.(finalRes);
  return finalRes;
}
