#!/usr/bin/env python3
"""
Omi Laya Decision Engine Worker
High-speed System 1 Non-Autoregressive Decision Engine
Provides single forward-pass typed decisions for Omi:
1. Voice Intent (Zero-LLM instant action routing)
2. Tool Pruning (stripping unneeded tools for minimal TTFT)
3. Computer Use Intent & Risk Assessment
4. Model Triage (Flash vs Reasoning models)
"""

import sys
import os
import json
import time
import argparse
from typing import Dict, Any, Optional

# Ensure UTF-8 output on Windows
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

# Suppress HuggingFace hub symlink warning
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

try:
    from laya import Router, Agent
    HAS_LAYA = True
except ImportError:
    HAS_LAYA = False

# Global Router instance
_ROUTER: Optional[Any] = None

def get_router():
    global _ROUTER
    if _ROUTER is None and HAS_LAYA:
        # Preload router so subsequent queries take only ~25-35ms
        try:
            _ROUTER = Router(preload=False, default="multilingual")
        except Exception as e:
            sys.stderr.write(f"[laya_worker] Router init failed: {e}\n")
    return _ROUTER

# ── 1. Voice Intent Questions ──────────────────────────────────────────────────
VOICE_INTENT_QUESTIONS = {
    "intent": {
        "type": "choice",
        "instructions": "Bu Türkçe sesli komutun gerçekleştirmek istediği temel eylem kategorisi nedir?",
        "criteria": {
            "music": "şarkı veya müzik durdur, devam et, sonraki şarkıya geç, önceki şarkı, şarkıyı kapat, sesi aç, sesi kıs, spotify müzik kontrolü",
            "open_app": "bilgisayarda yüklü bir oyunu, başlatıcıyı veya programı aç ya da başlat (örn: modrinth, minecraft, steam, discord, chrome, vs code, hesap makinesi)",
            "youtube": "youtube'da video aç, youtube'da ara, video izle, youtube'dan şarkı/video oynat",
            "system": "uygulamayı kapat, ekranı kilitle, pencereyi gizle veya masaüstü komutu",
            "chat": "bilgi sorusu, sohbet, genel konuşma, kod yazma, soru sorma, çeviri, analiz ve tavsiye isteme"
        }
    }
}

# ── 2. Tool Pruning Questions ──────────────────────────────────────────────────
TOOL_PRUNING_QUESTIONS = {
    "needs_web": {
        "type": "noul",
        "instructions": "Bu kullanıcı sorusu güncel internet araması, anlık hava durumu, haber veya canlı web bilgisi gerektiriyor mu?"
    },
    "needs_computer_use": {
        "type": "noul",
        "instructions": "Bu istek kullanıcının bilgisayar ekranında fareyle tıklama, klavye girişi yapma veya masaüstü arayüz otomasyonu gerektiriyor mu?"
    },
    "needs_email": {
        "type": "noul",
        "instructions": "Bu istek e-posta hazırlama, taslak oluşturma veya mail gönderme ile mi ilgili?"
    }
}

# ── 3. Computer Use Intent & Risk Questions ────────────────────────────────────
COMPUTER_USE_RISK_QUESTIONS = {
    "is_destructive": {
        "type": "noul",
        "instructions": "Bu masaüstü eylemi dosya silme, kayıt kapatma, programı zorla sonlandırma veya geri alınamaz kalıcı bir değişiklik içeriyor mu?"
    },
    "risk_level": {
        "type": "score",
        "instructions": "Bu bilgisayar işleminin risk ve tehlike derecesi nedir?",
        "criteria": [
            "tamamen güvenli okuma veya gezinme",
            "hafif değişiklik veya metin yazma",
            "kritik sistem değişikliği veya silme"
        ]
    }
}

# ── 4. Model Triage Questions ──────────────────────────────────────────────────
MODEL_TRIAGE_QUESTIONS = {
    "target_model": {
        "type": "choice",
        "instructions": "Bu isteği yanıtlamak için hangi model sınıfı daha uygundur?",
        "criteria": {
            "flash": "kısa sohbet, selamlama, basit bilgi, tek cümlelik soru, anlık cevap",
            "reasoning": "karmaşık kod mimarisi, derin mantıksal akıl yürütme, çok adımlı analiz veya problem çözme"
        }
    },
    "difficulty": {
        "type": "score",
        "instructions": "Bu isteğin karmaşıklık ve zorluk derecesi nedir?",
        "criteria": ["kolay ve basit", "orta seviye", "ileri düzey ve zor"]
    }
}

# ── Core Evaluation Functions ──────────────────────────────────────────────────

def evaluate_voice_intent(text: str) -> Dict[str, Any]:
    router = get_router()
    if not router:
        # Fallback heuristic
        lower = text.lower()
        if any(w in lower for w in ["şarkı", "müzik", "spotify", "durdur", "oynat", "sonraki", "önceki", "sesi aç", "sesi kıs"]):
            return {"intent": "music", "confidence": 0.95, "fallback": True}
        if any(w in lower for w in ["youtube", "youtubeda", "video aç", "video ara"]):
            return {"intent": "youtube", "confidence": 0.95, "fallback": True}
        if any(w in lower for w in ["aç", "başlat", "çalıştır"]) and not any(w in lower for w in ["nasıl", "neden", "anlat"]):
            return {"intent": "open_app", "confidence": 0.90, "fallback": True}
        return {"intent": "chat", "confidence": 0.80, "fallback": True}

    res = router.predict(text, VOICE_INTENT_QUESTIONS, model="multilingual")
    choice_data = res.get("answers", {}).get("intent", {})
    return {
        "intent": choice_data.get("choice", "chat"),
        "confidence": choice_data.get("answer_confidence", 0.0),
        "probabilities": choice_data.get("probabilities", {}),
        "fallback": False
    }

def evaluate_tool_pruning(text: str) -> Dict[str, Any]:
    router = get_router()
    if not router:
        lower = text.lower()
        return {
            "needs_web": any(w in lower for w in ["hava", "haber", "güncel", "kaç para", "fiyat", "araştır", "google"]),
            "needs_computer_use": any(w in lower for w in ["ekrana tıkla", "tıkla", "fareyi", "butona bas", "pencereyi"]),
            "needs_email": any(w in lower for w in ["mail", "e-posta", "eposta", "e posta"]),
            "fallback": True
        }

    res = router.predict(text, TOOL_PRUNING_QUESTIONS, model="multilingual")
    answers = res.get("answers", {})
    return {
        "needs_web": answers.get("needs_web", {}).get("value", False),
        "needs_computer_use": answers.get("needs_computer_use", {}).get("value", False),
        "needs_email": answers.get("needs_email", {}).get("value", False),
        "fallback": False
    }

def evaluate_computer_use_risk(action_desc: str) -> Dict[str, Any]:
    router = get_router()
    if not router:
        lower = action_desc.lower()
        destructive = any(w in lower for w in ["sil", "delete", "remove", "kapat", "kill", "format", "satın al", "buy"])
        return {
            "is_destructive": destructive,
            "risk_score": 1.8 if destructive else 0.2,
            "fallback": True
        }

    res = router.predict(action_desc, COMPUTER_USE_RISK_QUESTIONS, model="multilingual")
    answers = res.get("answers", {})
    is_dest = answers.get("is_destructive", {}).get("value", False)
    score_data = answers.get("risk_level", {})
    return {
        "is_destructive": is_dest,
        "risk_score": score_data.get("score", 0.0),
        "confidence": score_data.get("confidence", 0.0),
        "fallback": False
    }

def evaluate_model_triage(prompt: str) -> Dict[str, Any]:
    router = get_router()
    if not router:
        is_reasoning = len(prompt) > 250 or any(w in prompt.lower() for w in ["refactor", "mimari", "algoritma", "debug", "optimizasyon"])
        return {
            "target_model": "reasoning" if is_reasoning else "flash",
            "difficulty": 1.5 if is_reasoning else 0.3,
            "fallback": True
        }

    res = router.predict(prompt, MODEL_TRIAGE_QUESTIONS, model="multilingual")
    answers = res.get("answers", {})
    target = answers.get("target_model", {}).get("choice", "flash")
    diff = answers.get("difficulty", {}).get("score", 0.0)
    return {
        "target_model": target,
        "difficulty": diff,
        "fallback": False
    }

def run_server(port: int = 41420):
    try:
        from fastapi import FastAPI
        from pydantic import BaseModel
        import uvicorn
    except ImportError:
        sys.stderr.write("[laya_worker] fastapi or uvicorn missing. Run `pip install fastapi uvicorn`.\n")
        sys.exit(1)

    app = FastAPI(title="Omi Laya Decision Engine")

    class VoiceIntentReq(BaseModel):
        text: str

    class ToolPruningReq(BaseModel):
        text: str

    class ComputerUseRiskReq(BaseModel):
        action: str

    class ModelTriageReq(BaseModel):
        prompt: str

    class GenericPredictReq(BaseModel):
        state: Any
        questions: Dict[str, Any]

    @app.get("/health")
    def health():
        return {"status": "ok", "has_laya": HAS_LAYA, "loaded": _ROUTER is not None}

    @app.post("/voice_intent")
    def voice_intent(req: VoiceIntentReq):
        return evaluate_voice_intent(req.text)

    @app.post("/tool_pruning")
    def tool_pruning(req: ToolPruningReq):
        return evaluate_tool_pruning(req.text)

    @app.post("/computer_use_risk")
    def computer_use_risk(req: ComputerUseRiskReq):
        return evaluate_computer_use_risk(req.action)

    @app.post("/model_triage")
    def model_triage(req: ModelTriageReq):
        return evaluate_model_triage(req.prompt)

    @app.post("/predict")
    def generic_predict(req: GenericPredictReq):
        router = get_router()
        if not router:
            return {"error": "Laya not available"}
        return router.predict(req.state, req.questions, model="multilingual")

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

# ── CLI & One-Shot Mode ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Omi Laya Decision Engine Worker")
    parser.add_argument("--server", action="store_true", help="Run as HTTP daemon")
    parser.add_argument("--port", type=int, default=41420, help="Daemon port (default: 41420)")
    parser.add_argument("--task", type=str, choices=["voice_intent", "tool_pruning", "computer_use_risk", "model_triage"], help="Task name")
    parser.add_argument("--input", type=str, help="Input text or action")
    args = parser.parse_args()

    if args.server:
        run_server(args.port)
        return

    if args.task and args.input:
        if args.task == "voice_intent":
            res = evaluate_voice_intent(args.input)
        elif args.task == "tool_pruning":
            res = evaluate_tool_pruning(args.input)
        elif args.task == "computer_use_risk":
            res = evaluate_computer_use_risk(args.input)
        elif args.task == "model_triage":
            res = evaluate_model_triage(args.input)
        else:
            res = {"error": "unknown task"}
        print(json.dumps(res, ensure_ascii=False))
        return

    parser.print_help()

if __name__ == "__main__":
    main()
