---
name: humanizer
description: |
  Rewrite AI-sounding text so it reads like a human writer without changing what it says.
  Use when editing or reviewing prose for AI tells: not-X-but-Y contrasts, one-line
  closers, staged openers, forced triads, dashes everywhere, inflated claims, sales
  language, stock AI words, bold labels, or filler. Built for Google Gemini and Coucou / Omi.
  Based on Wikipedia's "Signs of AI writing".
license: MIT
metadata:
  version: "3.1.0"
  author: "blader/humanizer (adapted for Gemini & Omi)"
---

# Humanizer: Yapay Zeka Metin Kalıplarını Temizleme ve Doğallaştırma Becerisi (Gemini & Omi)

Yapay zeka (LLM) tarafından üretilmiş yapay, klişe, abartılı ve kalıplaşmış metinleri insan yazmış gibi akıcı, doğal ve özgün hale getirir. Metnin taşıdığı asıl anlam ve olgular kesinlikle korunur, uydurma bilgi eklenmez.

Wikipedia editörlerinin yapay zeka metinlerini tespit etmek için kullandığı resmi ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) kılavuzuna dayanır.

---

## 🎯 Temel Felsefe: Yapay Zeka Metinleri Neden Yapay Duyulur?

Büyük dil modelleri (LLM) istatistiksel olarak sıradaki en olası kelimeyi tahmin eder; bu yüzden varsayılan olarak en geniş kitleye hitap eden jenerik, ortalama ve dramatik yapıları seçer. İnsan ise tek bir okuyucu ve belirli bir konu için yazar.

Bir metnin yapay zeka tarafından yazıldığını gösteren en belirgin 5 yapı:
1. **Not X but Y (X değil, Y):** "Bu sadece bir özellik değil, bir devrimdir." -> Doğrudan söyle.
2. **Tek satırlık dramatik kapanışlar:** "Bunu bir düşünün.", "İşte asıl zafer bu." -> Gereksiz tekrarları ve kapanışları kes.
3. **Derin görünen aforizmalar:** "İşin özünde yatan asıl gerçek...", "Simetri güvenin dilidir." -> Somut iddiayı yaz.
4. **Sahnelenmiş sahte girişler:** "Hadi derinlemesine inceleyelim.", "Dürüst olmak gerekirse?", "Şöyle ki..." -> Giriş lafazanlığını at, doğrudan konuya gir.
5. **Hayali muhatapla tartışma:** "Şimdi bunu söylemiyorum ama...", "Kolay bir yol şu olabilirdi ama..." -> Savunmayı bırak, asıl gerçeği söyle.

---

## 🛠️ Gemini & Omi ile Kullanım

### 1. Doğrudan Komut (Slash Command)
```
/humanizer [metin veya dosya yolu]
/humanize [metin]
```

### 2. Doğal Dil ile İstek
- "Şu metni humanizer kurallarıyla doğal bir Türkçeye çevir/düzenle:"
- "docs/README.md dosyasındaki yapay zeka kokan cümleleri humanizer ile temizle."

### 3. Ses / Üslup Eşleştirme (Voice Matching)
Kullanıcı kendi yazdığı 1-2 paragraflık örnek verirse, model kullanıcının cümle uzunluğu, kelime seçimi, noktalama alışkanlıkları ve ritmine tam uyum sağlar.

---

## 📋 26 Temel Yapay Zeka Deseni (The 26 Patterns)

### A. Sahneleme (Staging instead of stating)
1. **Not X but Y:** "Bu sadece bir araç değil, bir vizyondur." yerine "Bu araç iş akışını hızlandırır."
2. **Tek satırlık dramatik kapanışlar:** "Ve her şey değişti.", "Let that sink in.", "Nokta." gibi ucuz vurguları sil.
3. **Derin görünen boş laflar:** "Özünde", "temelde", "aslında olan", "X, Y'nin aynasıdır" gibi aforizmaları somutlaştır.
4. **Sahnelenmiş girişler:** "Gelin başlayalım", "İşte bilmeniz gerekenler", "Açık konuşmak gerekirse" ifadelerini kes.
5. **Kimseyle tartışma:** "Bunun kolay olduğunu söylemiyorum ama..." gibi havayla dövüşen cümleleri kaldır.

### B. Kuralcı Ritim (Rhythm by rule)
6. **Zoraki üçlemeler (Triads):** Her fikri 3 maddede veya "yenilik, ilham ve içgörü" gibi 3'lü gruplarda toplamayı bırak. Kaç öge gerekiyorsa o kadar yaz.
7. **Tekrarlayan cümle başlangıçları:** Art arda her cümleyi "O...", "Sistem...", "Bu durum..." ile başlatma; cümle yapılarını ve uzunluklarını çeşitlendir.
8. **Tire bolluğu (Em-dashes —):** Her cümleye gereksiz uzun tireler (—) sokma; nokta, virgül veya iki nokta kullan.
9. **Yığılmış ihtiyat kelimeleri:** "Potansiyel olarak düşünülebileceği iddia edilebilir ki..." yerine "Bu durum sonucu etkileyebilir." de.
10. **Gereksiz birleşik sıfatlar:** Doğal akışa uymayan zoraki kalıpları sadeleştir.
11. **Öznesiz/Edilgen kaçışlar:** "Yapılandırmaya ihtiyaç duyulmaz" yerine "Yapılandırma dosyasına gerek yoktur."

### C. Şişirme ve Ödünç Otorite (Inflation & Borrowed Authority)
12. **Aşırı kullanılan YZ kelimeleri:**
    - İngilizce: *delve, testament, tapestry, landscape, pivotal, robust, crucial, bolster, enduring, vibrant, showcase, intricacies*.
    - Türkçe: *derinlemesine incelemek, dönüm noktası, canlı ekosistem, şüphesiz, adeta bir köprü vazifesi gören, hayati öneme sahip, adeta, büyüleyici doku*.
13. **Yapay önem atfetme:** "Bu gelişme bölgesel tarihte bir dönüm noktası oldu" -> Olayı ve tarihi söyle, önemini sıfatlarla şişirme.
14. **Muallak bağlaçlar:** "...ile ilişkili olarak", "...bağlamında değerlendirildiğinde" yerine somut ilişkiyi belirt.
15. **Sığ bağlaç ekleri (-erek, -erek yansıtan):** Bir cümlenin sonuna yapay derinlik katmak için eklenen "topluluğun derin bağlarını yansıtarak..." kuyruklarını kes.
16. **Pazarlama / Satış ağzı:** "Büyüleyici doğasıyla kalbinizi çalacak olan..." yerine ne olduğunu sade bir dille anlat.
17. **İsimsiz otoriteler:** "Uzmanlar inanıyor ki...", "Eleştirmenler belirtiyor..." -> Kaynak varsa adını ver, yoksa afaki uzmanlara dayanma.
18. **Basit fiillerden kaçınma:** "...olarak hizmet vermektedir", "...niteliğini taşımaktadır" yerine doğrudan "...dır / ...vardır / ...sahiptir" kullan.

### D. Kuralcı Biçimlendirme (Formatting by rule)
19. **Dekoratif kalın (bold) kullanımı:** Her listenin başına iki nokta üst üste ile biten kalın başlıklar dizme. Düz metin olarak akıt.
20. **Emoji ve ok süslemeli başlıklar:** "🚀 Başlangıç Aşaması:", "⚡ Performans İpuçları:" gibi kurumsal YZ süslemelerini kaldır; temiz başlıklar kullan.
21. **Kıvrık tırnak işaretleri:** Standart tırnak işaretlerini kullan.

### E. Sohbet ve Taslak Kalıntıları (Leftovers)
22. **Sohbet robotu artıkları:** "Harika bir soru!", "Umarım bu yardımcı olur!", "Tabii ki, işte metniniz:" gibi asistan gevezeliklerini temizle.
23. **Bilgi sınırı bahaneleri:** "Mevcut kaynaklarda sınırlı bilgi bulunsa da..." yerine doğrudan bilinen gerçeği yaz.
24. **Başlığı ilk cümlede papağan gibi tekrarlama:** Başlığın zaten söylediği şeyi altındaki ilk cümlede tekrarlama.
25. **Konu yerine belge hakkında konuşma:** "Aşağıdaki tabloda görüleceği üzere...", "Bu fonksiyon şunun için yazılmıştır..." yerine doğrudan konunun kendisini anlat.

### F. Yanlış Okuyucu (Writing for the wrong reader)
26. **Zaten bilineni tekrar izah etme:** Okuyucunun bildiği temel kavramları ansiklopedik gibi baştan anlatma; doğrudan kararı ve eylemi öne al.

---

## 🔒 Dokunulmazlıklar (Invariants)
- **Kodlar ve Veriler:** Kod blokları (` ``` `), dosya yolları, inline kod (`...`), JSON/YAML anahtarları ve URL'ler KESİNLİKLE değiştirilmez.
- **Olgusal Doğruluk:** İsimler, sayılar, tarihler, alıntılar ve teknik parametreler asla değiştirilmez veya uydurulmaz.
