# Omi Universal Skills Arsenal (Evrensel Beceriler Kütüphanesi)

Tüm yapay zeka modelleri (**Claude**, **Google Antigravity & Gemini**, **OpenAI & GPT-4o**, **DeepSeek**, **Groq**, **Ollama & Yerel Modeller**, **Sesli Asistan**) için aktif olarak kullanılabilen entegre beceri kütüphanesi.

Bu kütüphane, dünyanın en popüler ve standartlaştırılmış 3 büyük açık kaynak beceri ekosistemini ve Google resmi becerilerini bir araya getirir:
1. **[ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)** — 32+ üretim düzeyi otonom ajan becerisi (UI/Artifacts, MCP, Test, Belgeler, 100+ Entegrasyon).
2. **[multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)** — LLM kodlama hatalarını ortadan kaldıran Andrej Karpathy mühendislik yönergeleri.
3. **[xvirobotics/metaskill](https://github.com/xvirobotics/metaskill)** — Her türlü proje için tek komutla uzman ajan takımı, tekil ajan veya yeni beceri oluşturan meta-motor.
4. **[google-gemini/gemini-skills](https://github.com/google-gemini/gemini-skills)** — Interactions API, Live WebSocket ve Omni Flash Video becerileri.

---

## 🚀 Hızlı Erişim & Slash Komutları

| Komut | Açıklama | Kaynak / Motor |
| :--- | :--- | :--- |
| `/skills` | Tüm modeller için aktif evrensel beceri katalogunu gösterir | Omi Skills Engine |
| `/karpathy` | Andrej Karpathy kodlama ilkelerini ve kontrol listesini görüntüler | `karpathy-guidelines` |
| `/karpathy check <kod/plan>` | Kod veya planı Karpathy sadelik ve cerrahi kurallarına göre denetler | `karpathy-guidelines` |
| `/metaskill <proje/rol>` | Projeye özel anında uzman ajan takımı mimarisi üretir | `metaskill` (xvirobotics) |
| `/metaskill agent <rol>` | Belirli bir görev için uzman ajan spesifikasyonu üretir | `metaskill` |
| `/metaskill skill <isim>` | Yeni bir slash command beceri iskeleti (`SKILL.md`) oluşturur | `metaskill` |
| `/composio` veya `/awesome` | Composio & Awesome Skills kataloğunu kategorilere göre listeler | `awesome-claude-skills` |
| `/mcp` | Model Context Protocol (MCP) sunucu ve istemci geliştirme becerisi | `mcp-builder` |
| `/artifact` | Tek dosyalık interaktif React/HTML web uygulaması ve görsel demo becerisi | `artifacts-builder` |
| `/changelog` | Git commitlerinden Keep A Changelog uyumlu sürüm notu üretimi | `changelog-generator` |
| `/organize` | Karışık dizinleri analiz edip kategorilerine göre düzenleme becerisi | `file-organizer` |
| `/doc <pdf\|docx\|pptx\|xlsx>` | Ofis belgeleri okuma, form doldurma, tablo ayıklama ve oluşturma | `document-skills` |
| `/webapp-test <url/app>` | Playwright / Cypress ile otomatik E2E senaryo ve test oluşturma | `webapp-testing` |
| `/gemini` | Google Gemini API, Live streaming ve Omni Flash Video rehberleri | `gemini-skills` |
| `/computer` (`/cu`) | Yerel Windows masaüstü otomasyonu (tıklama, yazma, ekran görüntüsü) | `computer_use` |
| `/playwright` (`/pw`) | Yüksek performanslı Chromium/Edge tarayıcı kontrolü ve web kazıma | `playwright` |
| `/omp` (`/review`, `/commit`) | Cerrahi Hashline düzenleme, P0-P3 inceleme ve atomik commit motoru | `omp_harness` |

---

## 🎯 1. Andrej Karpathy Kodlama Yönergeleri (`karpathy-guidelines`)

LLM'lerin varsayımlarda bulunmasını, gereksiz karmaşıklık üretmesini ve kontrolsüz değişiklikler yapmasını engelleyen 4 temel ilke:

1. **Think Before Coding (Kodlamadan Önce Düşün):**
   - Asla sessizce varsayımda bulunma. Kafa karışıklığını gizleme.
   - Birden fazla yorumlama veya yaklaşım varsa ödünleşimleri (tradeoffs) açıkça sun.
   - Daha sade bir yaklaşım varsa diret ve kullanıcıya izah et.
2. **Simplicity First (Önce Sadelik):**
   - Sorunu çözen asgari kodu yaz. İstenmeyen ve spekülatif "esneklik" üretme.
   - Tek kullanımlık kodlar için karmaşık soyutlamalar ve sınıflar kurma.
   - 50 satırda bitebilecek işi 200 satıra yayma.
3. **Surgical Changes (Cerrahi Değişiklikler):**
   - Yalnızca gereken dosya ve satırlara dokun.
   - Bozuk olmayan komşu kodları, yorumları veya formatı 'iyileştirmeye' kalkışma.
   - Yalnızca kendi değişikliklerinin bıraktığı yetimleri temizle; eski ölü koda dokunma.
4. **Goal-Driven Execution (Hedef Odaklı İcra):**
   - İşe başlamadan önce somut, doğrulanabilir başarı kriterleri belirle.
   - Yapılan her değişikliği testle veya çıktı ile doğrula; asla varsayımla "tamamlandı" deme.

---

## 🤖 2. Metaskill Motoru (`metaskill`)

Tek bir komutla (`/metaskill`) proje mimarisine uygun uzman ajan takımları kurar:
- **Team Mode:** Proje türünü (ör. `ios app with SwiftUI`, `fullstack React + Postgres`, `data science pipeline with PyTorch`) analiz eder ve Lead, Core Engineer, QA Tester ve Security Reviewer rollerinden oluşan koordineli bir ajan takımı çıkarır.
- **Agent Mode:** Belirli bir uzmanlık için rol yönergesi, sistem istemi ve araç kısıtlamalarını içeren ajan dosyası üretir.
- **Skill Mode:** Yeni bir slash command becerisi için `SKILL.md`, argüman ipuçları ve betik şablonu hazırlar.

---

## 🌟 3. Composio & Awesome Skills Kataloğu

| Kategori | Beceri Dizini | Açıklama |
| :--- | :--- | :--- |
| **Frontend & UI** | `artifacts-builder` | Tek dosyalık React/Tailwind/HTML interaktif web bileşenleri |
| | `canvas-design` | SVG grafikleri, görsel afişler, canvas düzenleri ve infografikler |
| | `theme-factory` | Erişilebilir, modern renk paletleri ve tasarım sistemleri |
| **Mimari & MCP** | `mcp-builder` | Model Context Protocol sunucu ve istemcileri (TS/Python) |
| **QA & Test** | `webapp-testing` | Playwright & Cypress ile uçtan uca otomatik test senaryoları |
| | `changelog-generator` | Commitlerden Keep A Changelog uyumlu sürüm notu üretimi |
| **Belgeler** | `document-pdf` | PDF formları, tablo ayıklama, birleştirme/bölme |
| | `document-docx` | Word belgeleri oluşturma, stil ve başlık düzenleme |
| | `document-pptx` | Sunum slaytları ve sunum şablonları hazırlama |
| | `document-xlsx` | Excel formülleri hesaplama ve tablo veri işleme |
| **Entegrasyonlar** | `connect` & `connect-apps` | GitHub, Slack, Linear, Jira, Gmail ve 100+ servis entegrasyonu |
| | `composio-skills` | 100'den fazla popüler SaaS servisinin eylem şablonları |
| **Üretkenlik & Araştırma** | `file-organizer` | Dizinleri analiz edip dosyaları kategorilere göre düzenleme |
| | `lead-research-assistant`| Şirket ve yönetici istihbaratı, lead araştırması |
| | `content-research-writer`| Derin teknik araştırma ve yapılandırılmış makale yazımı |
| | `developer-growth-analysis`| GitHub katkı analizi, PR hızı ve repo büyüme istatistikleri |
| | `invoice-organizer` | Faturalardan kalem, vergi ve tutar bilgilerini ayıklama |
| | `internal-comms` | Şirket içi bültenler, teknik notlar ve toplantı özetleri |
| | `domain-name-brainstormer` | Marka isimleri ve alan adı alternatifleri üretme |
| | `brand-guidelines` | Marka tutarlılığı, tipografi ve ses tonu denetimi |
| | `competitive-ads-extractor`| Rakip reklam stratejileri ve kreatif analizi |
| | `twitter-algorithm-optimizer` | Sosyal medya algoritma uyumlu içerik optimizasyonu |
| | `video-downloader` | Web video ve ses akışlarını indirme ve dönüştürme |
| | `image-enhancer` | Üretim varlıkları için görsel iyileştirme ve filtreleme |
| | `langsmith-fetch` | LLM izleme, gecikme ve prompt değerlendirmelerini çekme |
| | `slack-gif-creator` | Ekip kanalları için animasyonlu metin ve GIF üretimi |
| | `tailored-resume-generator`| İş ilanına özel ATS uyumlu özgeçmiş optimizasyonu |
| | `skill-creator` & `skill-share` | Yeni beceri geliştirme, paketleme ve dışa aktarma |

---

## 🛠️ Model Tarafından Çağrılma Sözdizimi (Tool & Code Block Invocations)

Modeller sohbet içinde doğrudan aşağıdaki JSON bloklarını üreterek bu becerileri çalıştırabilir:

```skill:karpathy
{"action": "check", "text": "incelenecek kod veya plan"}
```

```skill:metaskill
{"intent": "ios app with SwiftUI"}
```

```skill:awesome
{"name": "mcp-builder"}
```

```skill:computer_use
{"action": "screenshot"}
```

```skill:playwright
{"action": "navigate", "url": "https://example.com"}
```
